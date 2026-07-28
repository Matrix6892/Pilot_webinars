import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function loadLocalEnv() {
  try {
    const raw = await readFile(resolve(root, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // ponytail: environment variables can also be supplied by the launcher.
  }
}

await loadLocalEnv();

const standUrl = (process.env.STAND_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const bridgeToken = process.env.BRIDGE_TOKEN ?? "local-demo-bridge";
const primaryModel =
  process.env.OPENCODE_PRIMARY_MODEL ?? "opencode-go/mimo-v2.5";
const reviewerModel =
  process.env.OPENCODE_REVIEWER_MODEL ?? "opencode-go/deepseek-v4-flash";
const demoData = JSON.parse(
  await readFile(resolve(root, "data/paint-demo.json"), "utf8"),
);

let stopped = false;
let busy = false;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function agentRequest(payload, method = "POST") {
  const response = await fetch(`${standUrl}/api/agent`, {
    method,
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

async function addEvent(orderId, stage, title, detail) {
  await agentRequest({
    action: "event",
    orderId,
    stage,
    title,
    detail,
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
    if (start < 0 || end <= start) throw new Error("Model returned no JSON object");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

async function runOpenCode(model, prompt, title) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "opencode",
      [
        "run",
        "-m",
        model,
        "--format",
        "json",
        "--title",
        title,
        prompt,
      ],
      {
        cwd: root,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`OpenCode timed out for ${model}`));
    }, 120_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error(stderr.trim() || `OpenCode exited with ${code}`));
        return;
      }

      const textParts = [];
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "text" && typeof event.part?.text === "string") {
            textParts.push(event.part.text);
          }
        } catch {
          // Ignore non-event diagnostics.
        }
      }

      try {
        resolveRun(extractJson(textParts.join("\n")));
      } catch (error) {
        rejectRun(error);
      }
    });
  });
}

function primaryPrompt(job) {
  return `Ты — коммерческий агент демонстрационного завода красок «КОЛЕР».
Сохраняй заказ в границах фактов и полномочий. Ставь точность и безопасность выше стилистических эффектов.

ЗАКАЗ:
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

ИСТОЧНИКИ ИСТИНЫ:
${JSON.stringify(demoData, null, 2)}

Верни только один JSON-объект без markdown. Никаких инструментов и команд не вызывай.
Схема:
{
  "zone": "green|yellow|red",
  "decision": "quote|clarify|escalate",
  "confidence": 0.0,
  "understood": ["короткие подтверждённые факты"],
  "missing": ["существенные недостающие данные"],
  "product": null или {"sku":"","name":"","stockKg":0,"requestedKg":0,"pricePerKg":0,"total":0,"replenishmentDays":0},
  "market": {"checked":true,"summary":"","items":[{"competitor":"","pricePerKg":0,"deliveryDays":0,"checkedAt":""}]},
  "businessContext": "",
  "zoneReason": "",
  "managerNote": "",
  "options": [{"id":"split|alternative|contract","title":"","rationale":"","tradeoff":"","reply":""}],
  "reply": {"subject":"","body":""},
  "checks": ["что проверено"],
  "sources": ["какие источники использованы"],
  "review": {"model":"Модель-руководитель","verdict":"Ожидает ревью","notes":[]}
}

Правила:
- green: данных достаточно, полный объём есть, цена соблюдает границу;
- yellow: существенных данных мало, задай только нужные вопросы, расчёт выполни после ответа;
- red: дефицит или особые условия, предложи 2–3 способа сохранить клиента и заблокируй отправку до руководителя;
- числа бери только из источников;
- при дефиците явно раздели доступный и недостающий объём;
- рынок усиливает аргумент, минимальная цена остаётся жёсткой границей;
- письмо клиенту делай коротким, деловым и русскоязычным;
- используй прямые утвердительные формулировки, активные глаголы и ясные существительные;
- убирай оправдания и риторические противопоставления.`;
}

function reviewPrompt(job, draft) {
  return `Ты — независимая модель-руководитель коммерческого агента.
Проверь решение по заказу на фактические и коммерческие риски.

ЗАКАЗ:
${JSON.stringify(job, null, 2)}

КАТАЛОГ И ПРАВИЛА:
${JSON.stringify(demoData, null, 2)}

ЧЕРНОВИК АГЕНТА:
${JSON.stringify(draft, null, 2)}

Верни только короткий JSON без markdown с результатами проверки:
{
  "approved": true,
  "verdict": "короткий вердикт до 120 символов",
  "notes": ["не более четырёх конкретных результатов проверки"],
  "blockingIssues": ["только ошибки, из-за которых ответ нельзя использовать"]
}

Обязательно:
- блокируй обещание объёма больше остатка без разделённой поставки;
- блокируй цену ниже minPricePerKg;
- при zone=red отмечай ожидание решения человека;
- пиши только на русском языке;
- сохраняй исходные факты и проверяй только существенные риски;
- используй прямые утвердительные формулировки и активные глаголы.`;
}

function applyHardRules(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Agent result is not an object");
  }

  result.understood = Array.isArray(result.understood) ? result.understood : [];
  result.missing = Array.isArray(result.missing) ? result.missing : [];
  result.options = Array.isArray(result.options) ? result.options : [];
  result.checks = Array.isArray(result.checks) ? result.checks : [];
  result.sources = Array.isArray(result.sources) ? result.sources : [];

  if (result.product?.sku) {
    const sourceProduct = demoData.products.find(
      (product) => product.sku === result.product.sku,
    );
    if (sourceProduct) {
      const requestedKg = Number(result.product.requestedKg) || 0;
      result.product.name = sourceProduct.name;
      result.product.stockKg = sourceProduct.stockKg;
      result.product.pricePerKg = sourceProduct.pricePerKg;
      result.product.minPricePerKg = sourceProduct.minPricePerKg;
      result.product.replenishmentDays = sourceProduct.replenishmentDays;
      result.product.total = requestedKg * sourceProduct.pricePerKg;

      if (
        requestedKg > sourceProduct.stockKg ||
        sourceProduct.pricePerKg < sourceProduct.minPricePerKg
      ) {
        result.zone = "red";
        result.decision = "escalate";
        result.zoneReason = `Красная зона по жёсткому правилу: запрошено ${requestedKg} кг, в наличии ${sourceProduct.stockKg} кг. Любое обещание полного объёма требует решения руководителя.`;
        if (!result.checks.includes("Границу зоны определили жёсткие правила")) {
          result.checks.push("Границу зоны определили жёсткие правила");
        }
      }
    }
  }

  if (!["green", "yellow", "red"].includes(result.zone)) {
    throw new Error("Agent returned an unknown zone");
  }

  return result;
}

async function processJob(job) {
  busy = true;
  try {
    await addEvent(
      job.id,
      "inventory",
      "Агент открыл каталог и остатки",
      `${demoData.products.length} продуктов, цены и минимальные границы.`,
    );
    await addEvent(
      job.id,
      "market",
      "Агент решил проверить рынок",
      `Срез из ${demoData.market.length} сопоставимых предложений с датой проверки.`,
    );

    const draft = applyHardRules(
      await runOpenCode(
        primaryModel,
        primaryPrompt(job),
        `КОЛЕР · заказ ${job.id.slice(-6)}`,
      ),
    );

    await addEvent(
      job.id,
      "review",
      "Черновик передан второй модели",
      `${reviewerModel} проверяет объём, цену и границы полномочий.`,
    );

    const review = await runOpenCode(
      reviewerModel,
      reviewPrompt(job, draft),
      `КОЛЕР · ревью ${job.id.slice(-6)}`,
    );
    const result = draft;
    result.review = {
      model: reviewerModel,
      verdict:
        typeof review.verdict === "string"
          ? review.verdict.slice(0, 240)
          : review.approved
            ? "Факты и границы полномочий подтверждены"
            : "Найдены блокирующие замечания",
      notes: Array.isArray(review.notes)
        ? review.notes.slice(0, 4).map((item) => String(item).slice(0, 260))
        : [],
    };

    if (!review.approved && Array.isArray(review.blockingIssues)) {
      result.review.notes.push(
        ...review.blockingIssues.slice(0, 2).map((item) => `Блокер: ${String(item)}`),
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
    await agentRequest({
      action: "error",
      orderId: job.id,
      detail: error instanceof Error ? error.message : String(error),
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
console.log(`[bridge] agent=${primaryModel}`);
console.log(`[bridge] reviewer=${reviewerModel}`);

await Promise.all([heartbeatLoop(), jobLoop()]);
