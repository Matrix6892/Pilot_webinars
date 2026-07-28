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
const allowedModels = new Set(modelCatalog.options.map((model) => model.id));
const modelLabel = (id) =>
  modelCatalog.options.find((model) => model.id === id)?.label ?? id;
const fallbackPrimary =
  process.env.OPENCODE_PRIMARY_MODEL ?? modelCatalog.default;
const strongReviewer =
  process.env.OPENCODE_REVIEWER_MODEL ?? "opencode/gpt-5.6-sol";
const agentApiTimeoutMs = 12_000;
const openCodeTimeoutMs = 120_000;
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

function reviewerFor(primaryModel) {
  return primaryModel === strongReviewer
    ? "opencode-go/deepseek-v4-pro"
    : strongReviewer;
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

function toolSummary(event) {
  const tool = String(event.part?.tool ?? "web");
  const input = event.part?.state?.input ?? {};
  const rawUrl = typeof input.url === "string" ? input.url : "";
  let host = "";
  try {
    host = rawUrl ? new URL(rawUrl).hostname : "";
  } catch {
    host = "";
  }
  return {
    tool,
    detail: host
      ? `${tool}: ${host}`
      : tool === "websearch"
        ? "Выполнен поиск по публичным источникам"
        : "Открыт публичный источник",
  };
}

async function runOpenCode({ model, prompt, title, agent }) {
  const promptDirectory = await mkdtemp(join(tmpdir(), "koler-agent-"));
  const promptPath = join(promptDirectory, "request.md");
  await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });

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
        "-f",
        promptPath,
      ],
      {
        cwd: root,
        env: childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let forceKillTimer;

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
    }, openCodeTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
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

      const textParts = [];
      const tools = [];
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "text" && typeof event.part?.text === "string") {
            textParts.push(event.part.text);
          }
          if (event.type === "tool_use") tools.push(toolSummary(event));
        } catch {
          // Ignore non-event diagnostics.
        }
      }

      try {
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

function primaryPrompt(job) {
  return `${salesInstruction}

## Текущий заказ

${JSON.stringify(
  {
    company: job.company,
    website: job.website,
    subject: job.subject,
    body: job.body,
  },
  null,
  2,
)}

## Демонстрационные источники истины

${JSON.stringify(demoData, null, 2)}

## Уточнения запуска

- Верни один JSON-объект без Markdown.
- Числа продукта возьми только из демонстрационных источников.
- Пропусти веб-поиск для доменов .example и рутинной зелёной заявки.
- При реальном домене исследуй компанию, когда масштаб, профиль или надёжность могут изменить жёлтое или красное решение.
- Сохрани до трёх публичных источников в research.sources.
- Пиши активным русским языком без оправданий и риторических противопоставлений.`;
}

function reviewPrompt(job, draft) {
  return `${reviewerInstruction}

## Заказ

${JSON.stringify(job, null, 2)}

## Каталог, склад, прайс и правила

${JSON.stringify(demoData, null, 2)}

## Черновик агента

${JSON.stringify(draft, null, 2)}

Верни только JSON по схеме инструкции.`;
}

async function processJob(job) {
  busy = true;
  const primaryModel = selectedModel(job);
  const reviewerModel = reviewerFor(primaryModel);

  try {
    await addEvent(
      job.id,
      "model",
      "Выбран исполнитель",
      `${modelLabel(primaryModel)} получил инструкцию редакции 5.6.`,
    );
    await addEvent(
      job.id,
      "inventory",
      "Каталог и склад добавлены в задачу",
      `${demoData.products.length} продуктов, остатки, цены и минимальные границы.`,
    );
    await addEvent(
      job.id,
      "market",
      "Демонстрационный срез рынка подготовлен",
      `${demoData.market.length} синтетических предложений с датой среза.`,
    );

    const primaryRun = await runOpenCode({
      model: primaryModel,
      prompt: primaryPrompt(job),
      title: `Колер · заказ ${job.id.slice(-6)}`,
      agent: "koler-sales",
    });

    for (const tool of primaryRun.tools) {
      await addEvent(
        job.id,
        "research",
        "Агент открыл публичный источник",
        tool.detail,
      );
    }

    let result = normalizeAgentResult(primaryRun.value, demoData, job);

    if (result.research?.checked) {
      await addEvent(
        job.id,
        "research-result",
        "Контекст компании приложен",
        result.research.summary || "Публичные факты сохранены со ссылками.",
      );
    }

    await addEvent(
      job.id,
      "review",
      "Черновик передан ИИ-рецензенту",
      `${modelLabel(reviewerModel)} проверяет объём, цену, источники и полномочия.`,
    );

    try {
      const reviewRun = await runOpenCode({
        model: reviewerModel,
        prompt: reviewPrompt(job, result),
        title: `Колер · проверка ${job.id.slice(-6)}`,
        agent: "koler-reviewer",
      });
      result = applyReviewerResult(
        result,
        reviewRun.value,
        reviewerModel,
        demoData,
        job,
      );
    } catch (reviewError) {
      console.error(
        `[bridge] reviewer ${job.id}:`,
        reviewError instanceof Error ? reviewError.message : reviewError,
      );
      await addEvent(
        job.id,
        "review-fallback",
        "Решение передано руководителю",
        "ИИ-рецензент остановил проверку. Черновик сохранён и ожидает решения человека.",
        "error",
      ).catch(() => {});
      result = applyReviewerResult(
        result,
        {
          approved: false,
          verdict: "ИИ-проверка не завершена",
          notes: ["Черновик сохранён для проверки руководителем."],
          blockingIssues: ["Требуется ручная проверка перед отправкой."],
        },
        reviewerModel,
        demoData,
        job,
      );
    }

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
        "OpenCode остановил обработку. Письмо и журнал сохранены; запустите новую карточку.",
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

await Promise.all([heartbeatLoop(), jobLoop()]);
