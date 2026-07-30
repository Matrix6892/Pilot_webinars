import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyReviewerResult,
  normalizeAgentResult,
} from "../lib/agent-guard.mjs";
import {
  normalizeVisionObservation,
  resolveVisionImageUrl,
  visionPromptBlock,
} from "../lib/upload-guard.mjs";
import { downloadVisionImage } from "../lib/upload-vision.mjs";

const root = resolve(import.meta.dirname, "..");

async function loadLocalEnv() {
  try {
    const raw = await readFile(resolve(root, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // ponytail: the launcher may supply the same values.
  }
}

await loadLocalEnv();

const standUrl = (process.env.STAND_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const bridgeToken = process.env.BRIDGE_TOKEN?.trim();
if (!bridgeToken) {
  throw new Error("BRIDGE_TOKEN is required in .env.local");
}
const demoData = JSON.parse(
  await readFile(resolve(root, "data/paint-demo.json"), "utf8"),
);
const modelCatalog = JSON.parse(
  await readFile(resolve(root, "data/models.json"), "utf8"),
);
const salesInstruction = await readFile(
  resolve(root, "public/prompts/sales-agent.md"),
  "utf8",
);
const reviewerInstruction = await readFile(
  resolve(root, "public/prompts/reviewer.md"),
  "utf8",
);
const visionInstruction = await readFile(
  resolve(root, "public/prompts/vision-agent.md"),
  "utf8",
);
const allowedModels = new Set(modelCatalog.options.map((model) => model.id));
const modelLabel = (id) =>
  modelCatalog.options.find((model) => model.id === id)?.label ?? id;
const requestedPrimary =
  process.env.OPENCODE_PRIMARY_MODEL ?? modelCatalog.default;
const fallbackPrimary = allowedModels.has(requestedPrimary)
  ? requestedPrimary
  : modelCatalog.default;
const strongReviewer = "opencode-go/deepseek-v4-pro";
const visionModel = "opencode-go/mimo-v2.5";
const agentApiTimeoutMs = 12_000;
const openCodeTimeoutMs = 120_000;
const openCodeSearchTimeoutMs = 70_000;
const openCodeTerminationGraceMs = 5_000;

let stopped = false;
let busy = false;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function selectedModel(job) {
  return allowedModels.has(job.requestedModel)
    ? job.requestedModel
    : fallbackPrimary;
}

function reviewerFor() {
  return strongReviewer;
}

function demoDataForJob(job) {
  if (typeof job?.inventorySnapshotJson !== "string") return demoData;

  try {
    const snapshot = JSON.parse(job.inventorySnapshotJson);
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const stockBySku = new Map(
      items
        .filter(
          (item) =>
            typeof item?.sku === "string" &&
            Number.isFinite(Number(item?.stockKg)),
        )
        .map((item) => [
          item.sku,
          {
            stockKg: Math.max(0, Number(item.stockKg)),
            stockRevision: Number.isFinite(Number(item?.revision)) &&
              Number(item.revision) > 0
                ? Number(item.revision)
                : undefined,
            stockUpdatedAt: typeof item?.updatedAt === "string"
              ? item.updatedAt
              : undefined,
          },
        ]),
    );

    return {
      ...demoData,
      market: Array.isArray(snapshot?.market)
        ? snapshot.market
        : demoData.market,
      products: demoData.products.map((product) => {
        const liveStock = stockBySku.get(product.sku);
        return {
          ...product,
          stockKg: liveStock?.stockKg ?? product.stockKg,
          stockRevision:
            liveStock?.stockRevision ?? product.stockRevision,
          stockUpdatedAt:
            liveStock?.stockUpdatedAt ?? product.stockUpdatedAt,
        };
      }),
      inventorySnapshot: {
        version:
          typeof snapshot?.version === "string" ||
          typeof snapshot?.version === "number"
            ? String(snapshot.version)
            : "текущая",
        capturedAt:
          typeof snapshot?.capturedAt === "string"
            ? snapshot.capturedAt
            : "",
      },
    };
  } catch {
    return demoData;
  }
}

function storedJobJson(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function childEnvironment() {
  const names = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_COLOR",
    "OPENCODE_API_KEY",
    "OPENCODE_ENABLE_EXA",
    "OPENCODE_GO_API_KEY",
    "OPENAI_API_KEY",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
    "XDG_CONFIG_HOME",
  ];
  return Object.fromEntries(
    names
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
}

async function agentRequest(payload, method = "POST") {
  const response = await fetch(`${standUrl}/api/agent`, {
    method,
    signal: AbortSignal.timeout(agentApiTimeoutMs),
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
  });
  if (!response.ok) {
    throw new Error(`Agent API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function addEvent(orderId, stage, title, detail, state = "done") {
  await agentRequest({
    action: "event",
    orderId,
    stage,
    title,
    detail,
    state,
  });
}

function extractJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Model returned no JSON object");
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function inventorySnapshotDetail(productCount, version) {
  const normalizedVersion = String(version ?? "").trim();
  if (/^\d+$/.test(normalizedVersion)) {
    return `${productCount} товаров. Данные склада взяты из обновления № ${normalizedVersion}.`;
  }
  return `${productCount} товаров. Версия данных склада: ${
    normalizedVersion || "исходная"
  }.`;
}

function sourcePlanForJob(job) {
  const website = String(job?.website ?? "").trim();
  const company = String(job?.company ?? "").trim();
  const orderText = `${job?.subject ?? ""}\n${job?.body ?? ""}`;
  const mentionsInn = /(?:^|[^\p{L}])инн(?:[^\p{L}]|$)/iu.test(
    orderText,
  );
  const hasRealWebsite =
    Boolean(website) && !/\.example(?:[/:?#]|$)/iu.test(website);
  const hasSpecificCompanyName =
    company.length >= 4 &&
    !/^(?:клиент|частное лицо|физлицо|не указано|—)$/iu.test(company);
  const businessContextCanChangeDecision =
    /(?:тендер|конкурс|скидк|отсроч|после\s+(?:поставк|отгрузк)|сроч|завтра|пробн|тестов|провер|оборот|производ|парк|партн[её]р|долгосроч|фармацевт|медицин|санитар|дезинф(?:екц|иц)|склад|(?:^|[^\p{L}])пол(?:а|у|ом|ы|ов|е)?(?:[^\p{L}]|$))/iu.test(
      orderText,
    ) ||
    /(?:^|[^\d])(?:[1-9]|[1-3]\d|40)\s*(?:кг|килограмм)/iu.test(
      orderText,
    );
  const shouldSearchByName =
    hasSpecificCompanyName &&
    !website &&
    businessContextCanChangeDecision;
  const shouldCheckCompany =
    mentionsInn ||
    hasRealWebsite ||
    shouldSearchByName;
  return shouldCheckCompany
    ? {
        allowsPublicSearch: true,
        title: "Агент решил проверить компанию",
        detail: shouldSearchByName
          ? "Название компании и условия заказа могут повлиять на предложение. Агент проверит открытые источники и отдельно отметит совпадение по названию."
          : "ИНН или сайт помогут оценить масштаб клиента и выбрать следующий коммерческий шаг.",
      }
    : {
        allowsPublicSearch: false,
        title: "Для решения хватает данных заказа",
        detail:
          "Агент продолжает по письму, каталогу, складу и правилам продаж.",
      };
}

function isOpenCodeTimeout(error) {
  return /OpenCode timed out/iu.test(
    String(error instanceof Error ? error.message : error ?? ""),
  );
}

async function runPrimaryWithOfflineRetry({
  initialRun,
  offlineRun,
  onRetry,
}) {
  try {
    return await initialRun();
  } catch (error) {
    if (!isOpenCodeTimeout(error)) throw error;
    await onRetry();
    return offlineRun();
  }
}

function canonicalHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function toolSummary(event) {
  const tool = String(event.part?.tool ?? "web");
  const state = event.part?.state ?? {};
  const input = state.input ?? {};
  const rawUrls = [
    input.url,
    input.href,
    ...(Array.isArray(input.urls) ? input.urls : []),
  ];
  const observedUrls = [
    ...new Set(rawUrls.map(canonicalHttpUrl).filter(Boolean)),
  ];
  const status = String(state.status ?? "");
  const completed =
    !status || /^(?:completed|success|succeeded)$/iu.test(status);
  const failed = /^(?:error|failed)$/iu.test(status);
  const urls =
    completed && !/search/iu.test(tool) ? observedUrls : [];
  const query =
    typeof input.query === "string" && input.query.trim()
      ? input.query.trim()
      : "";
  const isWebAction =
    observedUrls.length > 0 ||
    query ||
    /(?:web|search|fetch|browse|http)/iu.test(tool);
  if (!isWebAction) return null;

  let host = "";
  try {
    host = observedUrls[0] ? new URL(observedUrls[0]).hostname : "";
  } catch {
    host = "";
  }
  return {
    tool,
    urls,
    detail: failed && host
      ? `Страница пока недоступна: ${host}`
      : !completed && host
        ? `Открывается страница: ${host}`
        : host
        ? `Открыта страница: ${host}`
      : "Выполнен поиск по открытым источникам",
  };
}

function toolEventKey(event, summary) {
  const callId =
    event.part?.callID ?? event.part?.callId ?? event.part?.id ?? "";
  return callId
    ? `${summary.tool}:${String(callId)}`
    : JSON.stringify([summary.tool, summary.detail]);
}

function createOpenCodeEventStream(onToolUse) {
  let buffer = "";
  const textParts = [];
  const tools = [];
  const toolIndexes = new Map();
  let publicationQueue = Promise.resolve();
  let publicationError;

  function acceptLine(line) {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && typeof event.part?.text === "string") {
        textParts.push(event.part.text);
      }
      if (event.type !== "tool_use") return;

      const summary = toolSummary(event);
      if (!summary) return;
      const key = toolEventKey(event, summary);
      const existingIndex = toolIndexes.get(key);
      if (existingIndex !== undefined) {
        if (!tools[existingIndex].urls.length && summary.urls.length) {
          tools[existingIndex] = summary;
        }
        return;
      }
      if (tools.length >= 20) return;
      toolIndexes.set(key, tools.length);
      tools.push(summary);

      if (typeof onToolUse === "function") {
        publicationQueue = publicationQueue
          .then(() => onToolUse(summary))
          .catch((error) => {
            publicationError ??= error;
          });
      }
    } catch {
      // Ignore non-event diagnostics.
    }
  }

  function push(chunk) {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) acceptLine(line);
  }

  async function waitForPublished() {
    await publicationQueue;
    if (publicationError) throw publicationError;
  }

  async function complete() {
    if (buffer.trim()) acceptLine(buffer);
    buffer = "";
    await waitForPublished();
    return { textParts, tools };
  }

  return { push, waitForPublished, complete };
}

async function runOpenCode({
  model,
  prompt,
  title,
  agent,
  files = [],
  onToolUse,
  timeoutMs = openCodeTimeoutMs,
}) {
  const promptDirectory = await mkdtemp(join(tmpdir(), "koler-agent-"));
  const promptPath = join(promptDirectory, "request.md");
  await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
  const fileArguments = [promptPath, ...files].flatMap((path) => ["-f", path]);

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "opencode",
      [
        "run",
        "--pure",
        "--agent",
        agent,
        "-m",
        model,
        "--format",
        "json",
        "--title",
        title,
        "Выполни приложенную задачу и верни только JSON.",
        ...fileArguments,
      ],
      {
        cwd: root,
        env: childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    let finished = false;
    let timedOut = false;
    let forceKillTimer;
    const eventStream = createOpenCodeEventStream(onToolUse);

    async function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      await rm(promptDirectory, { recursive: true, force: true });
      if (error) {
        rejectRun(error);
        return;
      }
      resolveRun(value);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, openCodeTerminationGraceMs);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      eventStream.push(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", async (error) => {
      await finish(error);
    });
    child.on("close", async (code) => {
      if (timedOut) {
        await finish(new Error(`OpenCode timed out for ${model}`));
        return;
      }
      if (code !== 0) {
        await finish(
          new Error(stderr.trim() || `OpenCode exited with ${code}`),
        );
        return;
      }

      try {
        const { textParts, tools } = await eventStream.complete();
        await finish(null, {
          value: extractJson(textParts.join("\n")),
          tools,
        });
      } catch (error) {
        await finish(error);
      }
    });
  });
}

async function visionObservationForJob(job) {
  const attachment = storedJobJson(job.attachmentJson, null);
  if (!resolveVisionImageUrl(attachment?.src, standUrl)) return null;

  let downloaded;
  await addEvent(
    job.id,
    "vision",
    "Модель для фото изучает снимок",
    "Отдельная модель отмечает только видимые признаки.",
    "active",
  );
  try {
    downloaded = await downloadVisionImage({ attachment, standUrl });
    if (!downloaded) return null;
    const run = await runOpenCode({
      model: visionModel,
      prompt: `${visionInstruction}

## Имя вложения

${JSON.stringify(String(attachment?.name ?? "photo"))}`,
      title: `Колер · фото ${job.id.slice(-6)}`,
      agent: "koler-reviewer",
      files: [downloaded.path],
    });
    const observation = normalizeVisionObservation(run.value);
    if (!observation) throw new Error("Vision model returned no observation");
    await addEvent(
      job.id,
      "vision-result",
      "Фото осмотрено",
      observation.summary || "Видимые признаки добавлены в задачу.",
    );
    return observation;
  } catch (error) {
    console.error(
      `[bridge] vision ${job.id}:`,
      error instanceof Error ? error.message : error,
    );
    await addEvent(
      job.id,
      "vision-fallback",
      "Фото оставлено для уточнения",
      "Агент продолжает работу и задаст клиенту вопросы по материалу и размерам.",
    ).catch(() => {});
    return null;
  } finally {
    if (downloaded) {
      await rm(downloaded.directory, { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }
}

function primaryPrompt(job, liveDemoData, visionObservation) {
  const visionBlock = visionPromptBlock(visionObservation);
  return `${salesInstruction}

## Текущий заказ

${JSON.stringify(
  {
    company: job.company,
    website: job.website,
    subject: job.subject,
    body: job.body,
    attachment: storedJobJson(job.attachmentJson, null),
    conversation: storedJobJson(job.conversationJson, []),
    round: Number(job.roundNo) || 1,
  },
  null,
  2,
)}

## Демонстрационные источники истины

${JSON.stringify(liveDemoData, null, 2)}

${visionBlock}

## Уточнения запуска

- Верни один JSON-объект без Markdown.
- Числа продукта возьми только из снимка склада внутри демонстрационных источников.
- Пропусти веб-поиск для доменов .example и рутинной зелёной заявки.
- Сайт и ИНН дают точное совпадение. По одному названию компании ищи осторожно и помечай каждый результат словами «Совпадение по названию».
- Не запрашивай факты, которые клиент уже сообщил. Для забора отдельно проверь материал, размеры и число окрашиваемых сторон.
- Для пола в компании с особыми требованиями сформулируй назначение как гипотезу, свяжи предварительный вариант только со свойствами каталога и задай один вопрос о материале, назначении, уборке и нагрузке.
- Предложи клиенту три понятных ответа: медицинский склад, обычный склад или другое помещение. При новом условии принеси технологу контекст и готовый способ проверки.
- При частичном остатке проверь учебную таблицу цен и наличия других поставщиков. Сохраняй точный остаток только из строки с датой проверки. Строка подтверждает свежесть расчёта; резерв другого поставщика появляется после его ответа. Если строки нет, перечисли данные для подтверждения у поставщика и предложи выпуск или поставку двумя партиями. Подготовь вариант с доступным объёмом, ценой, сроком, временем проверки и единым графиком для клиента. В письме сообщи, что запросишь у поставщика подтверждение объёма и срока. Каждый участок закрепи за продукцией одного поставщика; технолог проверит подготовку пола и применение двух красок на соседних участках.
- Не обещай ГОСТ, GMP, ISO, СанПиН, санитарную обработку, дезинфекцию или химическую стойкость без точного подтверждения в карточке товара с документом и источником.
- При реальном домене исследуй компанию, когда масштаб, профиль или надёжность могут изменить жёлтое или красное решение.
- Сохрани до трёх публичных источников в research.sources.
- Ставь research.checked=true, только когда открыл каждый сохранённый URL.
- Пиши активным русским языком без оправданий и риторических противопоставлений.`;
}

function reviewPrompt(job, draft, liveDemoData) {
  return `${reviewerInstruction}

## Заказ

${JSON.stringify(job, null, 2)}

## Каталог, склад, прайс и правила

${JSON.stringify(liveDemoData, null, 2)}

## Черновик агента

${JSON.stringify(draft, null, 2)}

Верни только JSON по схеме инструкции.`;
}

async function processJob(job) {
  busy = true;
  const primaryModel = selectedModel(job);
  const reviewerModel = reviewerFor();
  const liveDemoData = demoDataForJob(job);
  const inventoryVersion =
    liveDemoData.inventorySnapshot?.version ?? "исходная";

  try {
    await addEvent(
      job.id,
      "model",
      "Выбран исполнитель",
      `${modelLabel(primaryModel)} получил инструкцию, подготовленную GPT-5.6 Sol.`,
    );
    await addEvent(
      job.id,
      "inventory",
      "Каталог и склад добавлены в задачу",
      inventorySnapshotDetail(liveDemoData.products.length, inventoryVersion),
    );
    await addEvent(
      job.id,
      "market",
      "Цены похожих предложений подготовлены",
      `${liveDemoData.market.length} предложений с датой проверки.`,
    );
    const sourcePlan = sourcePlanForJob(job);
    await addEvent(
      job.id,
      "source-plan",
      sourcePlan.title,
      sourcePlan.detail,
    );

    const visionObservation = await visionObservationForJob(job);
    const prompt = primaryPrompt(job, liveDemoData, visionObservation);
    const runPrimary = ({
      agent,
      timeoutMs,
      runPrompt = prompt,
      publishResearch = false,
    }) =>
      runOpenCode({
        model: primaryModel,
        prompt: runPrompt,
        title: `Колер · заказ ${job.id.slice(-6)}`,
        agent,
        timeoutMs,
        onToolUse: publishResearch
          ? (tool) =>
              addEvent(
                job.id,
                "research",
                tool.urls.length
                  ? "Агент открыл публичный источник"
                  : "Агент ищет открытые источники",
                tool.detail,
              )
          : undefined,
      });
    const primaryRun = await runPrimaryWithOfflineRetry({
      initialRun: () =>
        runPrimary({
          agent: sourcePlan.allowsPublicSearch
            ? "koler-sales"
            : "koler-sales-local",
          timeoutMs: sourcePlan.allowsPublicSearch
            ? openCodeSearchTimeoutMs
            : openCodeTimeoutMs,
          publishResearch: sourcePlan.allowsPublicSearch,
        }),
      onRetry: () =>
        addEvent(
          job.id,
          "primary-retry",
          "Агент собирает итог по данным заказа",
          "Первый запуск занял больше времени. Агент сразу готовит итоговый ответ по письму, каталогу и свежим остаткам на складе.",
        ),
      offlineRun: () =>
        runPrimary({
          agent: "koler-sales-local",
          timeoutMs: openCodeTimeoutMs,
          runPrompt: `${prompt}

## Продолжение того же заказа

- Сразу собери итоговый JSON по письму, каталогу, свежему снимку склада и правилам.
- Используй только приложенные данные. Не вызывай веб-поиск и другие инструменты.
- Для research укажи checked=false, summary="" и sources=[].`,
        }),
    });

    const guardedJob = {
      ...job,
      openedSourceUrls: primaryRun.tools.flatMap((tool) => tool.urls),
    };
    let result = normalizeAgentResult(
      primaryRun.value,
      liveDemoData,
      guardedJob,
    );

    await addEvent(
      job.id,
      "review",
      "Черновик передан модели проверки",
      `${modelLabel(reviewerModel)} проверяет объём, цену, источники и полномочия.`,
      "active",
    );

    try {
      const reviewRun = await runOpenCode({
        model: reviewerModel,
        prompt: reviewPrompt(job, result, liveDemoData),
        title: `Колер · проверка ${job.id.slice(-6)}`,
        agent: "koler-reviewer",
      });
      result = applyReviewerResult(
        result,
        reviewRun.value,
        reviewerModel,
        liveDemoData,
        guardedJob,
      );
      await addEvent(
        job.id,
        "review-result",
        `${modelLabel(reviewerModel)} завершила проверку`,
        result.review?.verdict || "Факты и границы полномочий подтверждены.",
      ).catch(() => {});
    } catch (reviewError) {
      console.error(
        `[bridge] reviewer ${job.id}:`,
        reviewError instanceof Error ? reviewError.message : reviewError,
      );
      await addEvent(
        job.id,
        "review-fallback",
        "Решение передано руководителю",
        "Черновик и проверенные факты сохранены. Руководитель получил готовые варианты.",
        "error",
      ).catch(() => {});
      result = applyReviewerResult(
        result,
        {
          approved: false,
          verdict: "Руководитель получил пункты для решения",
          notes: ["Черновик сохранён для проверки руководителем."],
          blockingIssues: ["Требуется ручная проверка перед отправкой."],
        },
        reviewerModel,
        liveDemoData,
        guardedJob,
      );
    }

    await addEvent(
      job.id,
      "research-result",
      "Данные для решения собраны",
      [result.businessContext, result.research?.summary]
        .filter(Boolean)
        .join(" "),
    ).catch(() => {});

    await agentRequest({
      action: "result",
      orderId: job.id,
      result,
      agentModel: primaryModel,
      reviewerModel,
    });
  } catch (error) {
    console.error(
      `[bridge] job ${job.id}:`,
      error instanceof Error ? error.message : error,
    );
    await agentRequest({
      action: "error",
      orderId: job.id,
      detail:
        "Письмо и журнал сохранены. Запустите карточку снова или выберите другого исполнителя.",
    }).catch(() => {});
  } finally {
    busy = false;
  }
}

async function heartbeatLoop() {
  while (!stopped) {
    try {
      await agentRequest({ action: "heartbeat" });
    } catch (error) {
      console.error("[bridge] heartbeat:", error.message);
    }
    await sleep(15_000);
  }
}

async function jobLoop() {
  while (!stopped) {
    try {
      if (!busy) {
        const { job } = await agentRequest(null, "GET");
        if (job) await processJob(job);
      }
    } catch (error) {
      console.error("[bridge] poll:", error.message);
    }
    await sleep(2_000);
  }
}

process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});

console.log(`[bridge] ${standUrl}`);
console.log(`[bridge] default=${fallbackPrimary}`);
console.log(`[bridge] reviewer=${strongReviewer}`);
console.log(`[bridge] vision=${visionModel}`);

await Promise.all([heartbeatLoop(), jobLoop()]);
