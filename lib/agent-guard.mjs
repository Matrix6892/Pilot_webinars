import { createHash } from "node:crypto";
import {
  asksCompatibility,
  colorLabelFromText,
  deliveryPlanFromText,
  explicitSkuFromText,
  floorUseFactsFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  matchProduct,
  orderFactsFromText,
  quantityFromText,
  quotedUnitPrices,
} from "./order-facts.mjs";
import { buildSupplierPlan } from "./supplier-plan.mjs";
import {
  containsPersonalInference,
  normalizeVisionObservation,
} from "./upload-guard.mjs";

const money = new Intl.NumberFormat("ru-RU");
const decimal = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
});

const credentialTextPatterns = [
  /-----BEGIN(?: [^-\r\n]+)? PRIVATE KEY-----/iu,
  /-----END(?: [^-\r\n]+)? PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /(?:^|[\s"'([{])(?:cookie|set-cookie)\s*[:=]\s*[^\s,;]{8,}/iu,
  /(?:^|[\s"'([{])(?:authorization|auth[-_ ]?(?:entication|token|key)|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|session(?:[-_ ]?(?:id|token))?|csrf[-_ ]?token|api[-_ ]?key|x[-_ ]?api[-_ ]?key)\s*[:=]\s*["']?[A-Za-z0-9][A-Za-z0-9._~+/=-]{7,}/iu,
  /\b(?:sk-|sk_(?:live|test)_|pk_(?:live|test)_|rk_(?:live|test)_|gh[pousr]_|github_pat_|xox[baprs]-|AIza|AKIA|ASIA|npm_|hf_|gsk_)[A-Za-z0-9._~+/=-]{8,}/u,
  /\b(?:jwt|token|secret(?:[-_ ]?(?:token|key))?|password|passwd)\s*[:=]\s*[A-Za-z0-9][A-Za-z0-9._~+/=-]{11,}/iu,
];

function containsCredentialText(value) {
  return typeof value === "string" &&
    credentialTextPatterns.some((pattern) => pattern.test(value));
}

function containsCredentialValue(value, seen = new Set()) {
  if (containsCredentialText(value)) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Array.isArray(value)
    ? value.some((item) => containsCredentialValue(item, seen))
    : Object.values(value).some((item) => containsCredentialValue(item, seen));
}

const openedEvidenceClaim =
  "Технический аудит: публичная страница успешно открыта; содержимое и связь с задачей не подтверждены";
const MAX_OPENED_SOURCE_EXCERPT_CHARS = 12_000;
const EVIDENCE_STOP_ROOTS = new Set([
  "этот", "этой", "страниц", "страни", "описыва", "page", "descri",
  "источник", "открыт", "публичн", "содерж",
  "данн", "может", "будет", "котор", "также", "тольк", "чтобы",
]);
const openedResearchFallback =
  "Публичная страница открыта; её коммерческие и технические свойства не подтверждены снимком или каталогом.";
const openedUnsupportedClaimPattern =
  /(?:\bRAL\b|КР-\d{1,4}|\b(?:SKU|артикул\p{L}*|код\p{L}*|food[- ]?safe|food[- ]?contact|non[- ]?toxic|heat[- ]?resistant|stock|price|delivery|guarantee)\b|₽|(?:^|[^\p{L}])(?:руб\p{L}*|цен(?:а|ы|е|у|ой|ою|ам|ами|ах|ов\p{L}*|ник\p{L}*|ообраз\p{L}*)?|стоимост\p{L}*|налич\p{L}*|склад\p{L}*|остат\p{L}*|достав\p{L}*|постав\p{L}*|срок\p{L}*|гарант\p{L}*|обеспеч\p{L}*|пищев\p{L}*|термостойк\p{L}*|жаростойк\p{L}*|безопас\p{L}*|токсич\p{L}*)(?=$|[^\p{L}]))/iu;
const supplierCommercialPatterns = {
  price:
    /(?:₽|\b(?:price|pricing)\b|(?:^|[^\p{L}])(?:цен\p{L}*|стоимост\p{L}*|прайс\p{L}*)(?=$|[^\p{L}]))/iu,
  stock:
    /(?:\b(?:stock|availability)\b|(?:^|[^\p{L}])(?:налич\p{L}*|остат\p{L}*|склад\p{L}*)(?=$|[^\p{L}]))/iu,
  delivery:
    /(?:\b(?:delivery|shipping|lead[- ]?time)\b|(?:^|[^\p{L}])(?:достав\p{L}*|срок\p{L}*|отгруз\p{L}*|логист\p{L}*)(?=$|[^\p{L}]))/iu,
};
const supplierConfirmationText = {
  price: "Подтвердить цену поставщика.",
  stock: "Подтвердить остаток поставщика.",
  delivery: "Подтвердить срок доставки.",
};

function supplierCommercialKinds(value) {
  return Object.entries(supplierCommercialPatterns)
    .filter(([, pattern]) => pattern.test(text(value)))
    .map(([kind]) => kind);
}

function supplierObservationClauses(value) {
  return text(value)
    .split(
      /(?:;|\n|,\s*(?=(?:₽|price|pricing|stock|availability|delivery|shipping|lead[- ]?time|цена|цен\p{L}*|стоимост\p{L}*|прайс|налич\p{L}*|остат\p{L}*|склад\p{L}*|достав\p{L}*|срок\p{L}*|отгруз\p{L}*|логист\p{L}*)))/iu,
    )
    .map((clause) => text(clause))
    .filter(Boolean);
}

function safeSupplierClause(value) {
  const candidate = cleanSemanticCopy(value).replace(/[.!?]+$/u, "").trim();
  return candidate ? `${candidate}.` : "";
}

function safeOpenedResearchFact(value) {
  const candidate = cleanSemanticCopy(value);
  if (!candidate) return openedResearchFallback;
  const fragments = candidate.match(/[^.!?\n]+[.!?]+/gu) ?? [candidate];
  const safeFragments = fragments.filter(
    (fragment) => !openedUnsupportedClaimPattern.test(fragment),
  );
  return safeFragments.join(" ").trim() || openedResearchFallback;
}

function safeOpenedSourceTitle(value) {
  const candidate = cleanSourceText(value, 180);
  return candidate &&
    !openedUnsupportedClaimPattern.test(candidate) &&
    !hasUntrustedInstructionText(candidate)
    ? candidate
    : "Открытая публичная страница";
}

function hasSensitiveDraftText(value) {
  return containsCredentialValue(value);
}

function countedNoun(value, one, few, many) {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = value % 10;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}
const safeTemplateReplacementCheck =
  "Клиентский текст приведён к ясному русскому шаблону";
const safeRhetoricReplacementCheck =
  "Клиентский текст приведён к правилам деловой переписки";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasUnexpectedLatin(value) {
  const candidate = text(value).replace(/\bRAL(?:\s*\d{4})?\b/gi, "");
  const latinWords = candidate.match(/\b[A-Za-z]{3,}\b/g) ?? [];
  if (latinWords.length < 3) return false;
  const latinLetters = candidate.match(/[A-Za-z]/g)?.length ?? 0;
  const cyrillicLetters = candidate.match(/[А-ЯЁа-яё]/g)?.length ?? 0;
  return cyrillicLetters === 0 || latinLetters > cyrillicLetters * 2;
}

function hasUntrustedInstructionText(value) {
  return /(?:\bагент\p{L}*|учебн\p{L}*\s+(?:таблиц\p{L}*|каталог\p{L}*)|этап\p{L}*\s+стенд\p{L}*|модел\p{L}*\s+(?:провер|подготов)|выбор\p{L}*\s+руководител\p{L}*|системн\p{L}*\s+(?:инструкц\p{L}*|промпт\p{L}*)|секретн\p{L}*\s+(?:токен\p{L}*|ключ\p{L}*)|(?:раскр|покаж)\p{L}*\s+(?:промпт\p{L}*|инструкц\p{L}*|токен\p{L}*)|игнорир\p{L}*\s+(?:предыдущ\p{L}*|системн\p{L}*)|ignore\s+(?:all\s+)?previous|system\s+prompt|api[-_\s]?key|chain[-_\s]?of[-_\s]?thought)/iu.test(
    text(value),
  );
}

function hasCjk(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u.test(
    text(value),
  );
}

const humanTargetPattern =
  /(?:^|[^\p{L}])(?:волос\p{L}*|кож(?:а|и|е|у|ей|ею|ою)|лиц(?:о|а|у|ом|е|ам|ами|ах)?|тел(?:о|а|у|ом|е|ам|ами|ах)?|человек\p{L}*|ладон\p{L}*|ресниц\p{L}*|губ(?:а|ы|е|у|ой|ою|ам|ами|ах)?|кист\p{L}*\s+рук(?:а|и|е|у|ой|ою|ам|ами|ах)?|рук(?:а|и|е|у|ой|ою|ам|ами|ах)?|част\p{L}*\s+тел(?:о|а|у|ом|е|ам|ами|ах)?|hair|hairs|face|faces|skin|body|bodies|hand|hands|person|people|human|individual|man|woman|boy|girl|actor|actress|performer)(?=$|[^\p{L}])/iu;
const unknownTargetPattern =
  /(?:^|[^\p{L}])(?:unknown|неизвестн\p{L}*|неопредел\p{L}*|неясн\p{L}*)(?=$|[^\p{L}])/iu;
const nonHumanTargetPattern =
  /(?:^|[^\p{L}])(?:стен\p{L}*|поверхн\p{L}*|пол\p{L}*|потол\p{L}*|двер\p{L}*|окон\p{L}*|штор\p{L}*|панел\p{L}*|корпус\p{L}*|прибор\p{L}*|мебел\p{L}*|кроват\p{L}*|раз[ъь]ем\p{L}*|объект\p{L}*|предмет\p{L}*|комнат\p{L}*|фасад\p{L}*|забор\p{L}*|ворот\p{L}*|кры\p{L}*|полот\p{L}*|шкаф\p{L}*|wall|surface|floor|ceiling|door|window|curtain|panel|housing|device|appliance|furniture|bed|connector|object|item|room|facade|fence)(?=$|[^\p{L}])/iu;
const nonHumanMaterialPattern =
  /(?:^|[^\p{L}])(?:металл\p{L}*|бетон\p{L}*|дерев\p{L}*|metal|concrete|wood)(?=$|[^\p{L}])/iu;

export function isHumanTarget(value) {
  const normalized = normalizedEvidenceText(value);
  const humanIndex = normalized.search(humanTargetPattern);
  const nonHumanIndex = normalized.search(nonHumanTargetPattern);
  return humanIndex >= 0 && (nonHumanIndex < 0 || humanIndex < nonHumanIndex);
}

function isExplicitNonHumanTarget(value) {
  const normalized = normalizedEvidenceText(value);
  return Boolean(
    normalized &&
      !isHumanTarget(normalized) &&
      !unknownTargetPattern.test(normalized) &&
      (nonHumanTargetPattern.test(normalized) ||
        nonHumanMaterialPattern.test(normalized)),
  );
}

function containsUnsupportedPersonalInference(value, targetLabel = "") {
  if (!containsPersonalInference(value)) return false;
  const withoutChildContext = text(value)
    .replace(/(?:детск\p{L}*\s+(?=кроват\p{L}*|мебел\p{L}*|комнат\p{L}*|стул\p{L}*)|для\s+реб[её]нк\p{L}*)/giu, "")
    .replace(/безопасност\p{L}*\s+для\s+реб[её]нк\p{L}*/giu, "");
  return (
    isHumanTarget(targetLabel) ||
    containsPersonalInference(withoutChildContext)
  );
}

function hasForbiddenContrast(value) {
  return /(?:^|\s)не\s+[^.!?\n]{0,140}\s+а\s+/iu.test(text(value));
}

function isAllCapsHeading(value) {
  const letters = text(value).match(/[А-ЯЁа-яё]/g) ?? [];
  return (
    letters.length >= 4 &&
    letters.every((letter) => letter === letter.toLocaleUpperCase("ru-RU"))
  );
}

function cleanSemanticCopy(value) {
  const candidate = text(value).replace(
    /минимальн(?:ая|ой|ую)\s+цен[аы](?:\s+с\s+прибылью)?/giu,
    "цена, от которой завод зарабатывает на заказе",
  );
  return candidate &&
    !containsCredentialText(candidate) &&
    !hasCjk(candidate) &&
    !hasUntrustedInstructionText(candidate)
    ? candidate
    : "";
}

function cleanCopy(value) {
  const candidate = cleanSemanticCopy(value);
  return candidate &&
    !hasUnexpectedLatin(candidate) &&
    !hasForbiddenContrast(candidate) &&
    !isAllCapsHeading(candidate)
    ? candidate
    : "";
}

function cleanClientCopy(value) {
  const candidate = cleanCopy(value);
  return candidate && /[А-ЯЁа-яё]/u.test(candidate)
    ? candidate
    : "";
}

function cleanSourceText(value, max = 160) {
  const candidate = text(value).replace(/\s+/g, " ").slice(0, max);
  return candidate && !containsCredentialText(candidate) && !hasCjk(candidate)
    ? candidate
    : "";
}

function cleanList(value) {
  return Array.isArray(value)
    ? value.map(cleanCopy).filter(Boolean).slice(0, 8)
    : [];
}

function cleanSemanticList(value) {
  return Array.isArray(value)
    ? value.map(cleanSemanticCopy).filter(Boolean).slice(0, 8)
    : [];
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function completeText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const reviewerIssueRules = new Set([
  "target_consistency",
  "human_safety",
  "unsupported_claim",
  "authority",
  "evidence_integrity",
  "material_utility",
  "privacy",
]);
const MAX_REVIEWER_ISSUES = 16;
const MAX_REVIEWER_VALIDATION_ERRORS = 32;

const reviewerRulePathPrefixes = {
  target_consistency: [
    "/order",
    "/result/resolvedIntent/target",
    "/result/resolvedIntent/evidence",
    "/result/understood",
    "/result/missing",
    "/result/product",
    "/result/estimates",
    "/result/supplierLeads",
    "/result/reply",
  ],
  human_safety: [
    "/result/product",
    "/result/estimates",
    "/result/reply",
    "/result/options",
  ],
  unsupported_claim: [
    "/order",
    "/result/resolvedIntent/evidence",
    "/result/research",
    "/result/supplierLeads",
    "/result/product",
    "/result/supplierPlan",
    "/result/market",
    "/result/estimates",
    "/result/decisionBasis",
    "/result/reply",
    "/result/options",
  ],
  authority: [
    "/order",
    "/result/commitment",
    "/result/product",
    "/result/supplierPlan",
    "/result/supplierLeads",
    "/result/research",
    "/result/decisionBasis",
    "/result/reply",
    "/result/options",
  ],
  evidence_integrity: [
    "/order",
    "/result/resolvedIntent/evidence",
    "/result/research",
    "/result/supplierLeads",
    "/result/product",
    "/result/supplierPlan",
    "/result/market",
    "/result/estimates",
    "/result/decisionBasis",
    "/result/reply",
    "/result/options",
  ],
  material_utility: [
    "/order",
    "/result/commitment",
    "/result/managerNote",
    "/result/options",
    "/result/reply",
  ],
  privacy: [
    "/order",
    "/result/visionObservation",
    "/result/resolvedIntent/target",
    "/result/resolvedIntent/evidence",
    "/result/understood",
    "/result/product",
    "/result/estimates",
    "/result/supplierLeads",
    "/result/research",
    "/result/reply",
    "/result/options",
  ],
};

function reviewerOptionsAreStructurallyValid(packet) {
  const options = packet?.result?.options;
  return Boolean(
    Array.isArray(options) &&
      options.length === 3 &&
      options.every(
        (option) =>
          objectRecord(option) &&
          completeText(option.id) &&
          completeText(option.reply),
      ),
  );
}

function isTargetAmbiguityBoundary(result) {
  return Boolean(
    result?.zone === "yellow" &&
      result.route === "needs_info" &&
      result.commitment === "none" &&
      result.resolvedIntent?.target?.state === "ambiguous" &&
      result.resolvedIntent?.blocker?.kind === "target_ambiguity" &&
      completeText(result.resolvedIntent.blocker.question) &&
      result.product === null &&
      Array.isArray(result.estimates) &&
      result.estimates.length === 0 &&
      Array.isArray(result.supplierLeads) &&
      result.supplierLeads.length === 0 &&
      Array.isArray(result.options) &&
      result.options.length === 0 &&
      completeText(result.reply?.body) &&
      (result.reply.body.match(/\?/gu) ?? []).length === 1
  );
}

function hasStructuredTargetCandidates(result) {
  const candidates = result?.resolvedIntent?.target?.candidates;
  return Boolean(
    Array.isArray(candidates) &&
      candidates.length >= 2 &&
      candidates.every(
        (candidate) => objectRecord(candidate) && completeText(candidate.label),
      ),
  );
}

function isCanonicalAmbiguityReply(result) {
  const blocker = result?.resolvedIntent?.blocker;
  const targetCandidates = result?.resolvedIntent?.target?.candidates;
  const choices = Array.isArray(blocker?.choices)
    ? blocker.choices
    : Array.isArray(targetCandidates)
      ? targetCandidates.map((candidate) => candidate?.label)
      : [];
  return Boolean(
    hasStructuredTargetCandidates(result) &&
      completeText(result.reply?.body) &&
      result.reply.body === ambiguityReply(blocker.question, choices).body,
  );
}

function isCanonicalPureTargetAmbiguity(result) {
  return Boolean(
    isTargetAmbiguityBoundary(result) &&
      hasStructuredTargetCandidates(result) &&
      isCanonicalAmbiguityReply(result),
  );
}

function reviewerRulePathPrefixesForPacket(rule, packet) {
  // ponytail: canonical pure ambiguity has no reviewer issue surface; one
  // authoritative empty map covers every rule and every alias.
  if (isCanonicalPureTargetAmbiguity(packet?.result)) return [];
  if (rule === "human_safety" && isTargetAmbiguityBoundary(packet?.result)) {
    return [];
  }
  const prefixes = reviewerRulePathPrefixes[rule] ?? [];
  if (
    rule === "material_utility" &&
    reviewerOptionsAreStructurallyValid(packet)
  ) {
    return packet.result.options.map(
      (_option, index) => `/result/options/${index}/reply`,
    );
  }
  return prefixes;
}

function reviewerPathMatchesRule(rule, path, packet) {
  return reviewerRulePathPrefixesForPacket(rule, packet).some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function reviewerPointerValue(packet, path) {
  if (typeof path !== "string" || !path.startsWith("/") || /~(?![01])/u.test(path)) {
    return null;
  }
  let current = packet;
  for (const rawSegment of path.slice(1).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return null;
    }
    current = current[segment];
  }
  return current === undefined ? null : { value: current };
}

export function reviewerAllowedPathPrefixes(packet) {
  return Object.fromEntries(
    Object.keys(reviewerRulePathPrefixes).map((rule) => [
      rule,
      reviewerRulePathPrefixesForPacket(rule, packet).filter(
        (prefix) =>
          reviewerPathMatchesRule(rule, prefix, packet) &&
          reviewerPointerValue(packet, prefix),
      ),
    ]),
  );
}

function reviewerQuoteMatches(value, quote) {
  if (!completeText(quote)) return false;
  if (typeof value === "string") return value.includes(quote);
  try {
    return JSON.stringify(value) === quote;
  } catch {
    return false;
  }
}

function normalizeReviewerIssue(value, packet) {
  const issue = objectRecord(value);
  if (
    !issue ||
    !reviewerIssueRules.has(issue.rule) ||
    typeof issue.path !== "string" ||
    !issue.path.startsWith("/") ||
    !completeText(issue.detail)
  ) {
    return null;
  }
  if (!reviewerPathMatchesRule(issue.rule, issue.path, packet)) return null;
  const pointed = reviewerPointerValue(packet, issue.path);
  if (!pointed || !reviewerQuoteMatches(pointed.value, issue.quote)) return null;
  return {
    rule: issue.rule,
    path: issue.path,
    quote: issue.quote,
    detail: issue.detail.trim(),
  };
}

function reviewerValidationCode(index, reason) {
  return index === null ? `reviewer.${reason}` : `reviewer.issue[${index}].${reason}`;
}

/**
 * Returns bounded, non-sensitive ReviewerDecisionV2 validation codes only.
 * No verdict text, issue values, packet content, or model reasoning is exposed.
 */
export function reviewerDecisionValidationErrors(value, packet) {
  const errors = [];
  const addError = (code) => {
    if (errors.length < MAX_REVIEWER_VALIDATION_ERRORS) errors.push(code);
  };
  const verdict = objectRecord(value);
  if (Array.isArray(verdict?.blockingIssues) && verdict.blockingIssues.length > MAX_REVIEWER_ISSUES) {
    addError(reviewerValidationCode(null, "blocking_issues_too_many"));
  }
  if (!verdict) addError(reviewerValidationCode(null, "verdict_not_object"));
  else {
    if (verdict.schemaVersion !== 2) {
      addError(reviewerValidationCode(null, "schema_version_invalid"));
    }
    if (typeof verdict.approved !== "boolean") {
      addError(reviewerValidationCode(null, "approved_not_boolean"));
    }
    if (!completeText(verdict.verdict)) {
      addError(reviewerValidationCode(null, "verdict_empty"));
    }
    if (!Array.isArray(verdict.notes) || !verdict.notes.every(completeText)) {
      addError(reviewerValidationCode(null, "notes_not_string_array"));
    }
    if (!Array.isArray(verdict.blockingIssues)) {
      addError(reviewerValidationCode(null, "blocking_issues_not_array"));
    }
  }

  const packetRecord = objectRecord(packet);
  if (
    !packetRecord ||
    !Object.prototype.hasOwnProperty.call(packetRecord, "order") ||
    !Object.prototype.hasOwnProperty.call(packetRecord, "result") ||
    !objectRecord(packetRecord.order) ||
    !objectRecord(packetRecord.result)
  ) {
    addError(reviewerValidationCode(null, "packet_invalid"));
  } else if (hasSensitiveDraftText(packetRecord)) {
    addError(reviewerValidationCode(null, "packet_sensitive"));
  }
  if (verdict && hasSensitiveDraftText(verdict)) {
    addError(reviewerValidationCode(null, "verdict_sensitive"));
  }
  if (!verdict || !Array.isArray(verdict.blockingIssues)) return errors;

  let validIssueCount = 0;
  verdict.blockingIssues.slice(0, MAX_REVIEWER_ISSUES).forEach((value, index) => {
    const issue = objectRecord(value);
    if (!issue) {
      addError(reviewerValidationCode(index, "not_object"));
      return;
    }
    if (!reviewerIssueRules.has(issue.rule)) {
      addError(reviewerValidationCode(index, "rule_invalid"));
    }
    if (typeof issue.path !== "string" || !issue.path.startsWith("/") || /~(?![01])/u.test(issue.path)) {
      addError(reviewerValidationCode(index, "path_invalid"));
    } else if (!reviewerIssueRules.has(issue.rule) || !reviewerPathMatchesRule(issue.rule, issue.path, packet)) {
      addError(reviewerValidationCode(index, "path_not_allowed"));
    } else if (!reviewerPointerValue(packet, issue.path)) {
      addError(reviewerValidationCode(index, "path_missing"));
    }
    if (!completeText(issue.quote)) {
      addError(reviewerValidationCode(index, "quote_empty"));
    } else {
      const pointed = reviewerPointerValue(packet, issue.path);
      if (!pointed || !reviewerQuoteMatches(pointed.value, issue.quote)) {
        addError(reviewerValidationCode(index, "quote_mismatch"));
      }
    }
    if (!completeText(issue.detail)) {
      addError(reviewerValidationCode(index, "detail_empty"));
    }
    if (normalizeReviewerIssue(issue, packet)) validIssueCount += 1;
  });
  if (verdict.approved !== (validIssueCount === 0)) {
    addError(reviewerValidationCode(null, "approved_issue_count_mismatch"));
  }
  return errors;
}

/**
 * Returns a copied, contract-valid V2 decision or null. The packet is read
 * only; issue quotes must be grounded in its {order, result} JSON tree.
 */
export function normalizeReviewerDecisionV2(value, packet) {
  if (reviewerDecisionValidationErrors(value, packet).length > 0) return null;

  const blockingIssues = value.blockingIssues.map((issue) =>
    normalizeReviewerIssue(issue, packet),
  );
  if (
    blockingIssues.some((issue) => issue === null) ||
    value.approved !== (blockingIssues.length === 0)
  ) {
    return null;
  }
  return {
    schemaVersion: 2,
    approved: value.approved,
    verdict: value.verdict.trim(),
    notes: value.notes.map((note) => note.trim()),
    blockingIssues,
  };
}

export const validateReviewerDecisionV2 = normalizeReviewerDecisionV2;

function completeStringList(value, { allowEmpty = true } = {}) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(completeText)
  );
}

function completeNumber(value, minimum = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function completeCalculation(value) {
  if (value === undefined) return true;
  const calculation = objectRecord(value);
  const validKind = ["fence-area", "wall-area", "floor-area"].includes(
    calculation?.kind,
  );
  const validMaterial =
    calculation?.kind === "fence-area"
      ? ["дерево", "металл"].includes(calculation.material)
      : calculation?.kind === "wall-area"
        ? ["штукатурка", "бетон", "гипсокартон"].includes(
            calculation.material,
          )
        : calculation?.kind === "floor-area"
          ? calculation.material === "бетон"
          : false;
  return Boolean(
    calculation &&
      validKind &&
      validMaterial &&
      (calculation.lengthM === null ||
        completeNumber(calculation.lengthM, 0.01)) &&
      (calculation.heightM === null ||
        completeNumber(calculation.heightM, 0.01)) &&
      completeNumber(calculation.areaPerSideM2, 0.01) &&
      completeNumber(calculation.sides, 1) &&
      completeNumber(calculation.paintAreaM2, 0.01) &&
      completeNumber(calculation.coverageKgPerM2PerCoat, 0.01) &&
      completeNumber(calculation.coats, 1) &&
      completeNumber(calculation.reservePercent) &&
      completeNumber(calculation.estimatedKg, 0.01) &&
      completeNumber(calculation.packageKg, 0.01) &&
      completeNumber(calculation.packages, 1) &&
      completeNumber(calculation.roundedKg, 0.01) &&
      completeText(calculation.explanation),
  );
}

function matchesCanonicalSupplierPlan(plan, canonicalPlan) {
  const scalarFields = [
    "category",
    "supplierName",
    "ourKg",
    "supplierKg",
    "ourPricePerKg",
    "supplierPricePerKg",
    "ourSubtotal",
    "supplierSubtotal",
    "total",
    "deliveryDays",
    "supplierStockKg",
    "stockCheckedAt",
    "offersChecked",
    "eligibleOffers",
    "selectionRule",
  ];
  const offerFields = [
    "supplierName",
    "pricePerKg",
    "deliveryDays",
    "stockKg",
    "stockCheckedAt",
    "canCover",
    "selected",
  ];
  return Boolean(
    scalarFields.every((field) => plan[field] === canonicalPlan[field]) &&
      Array.isArray(plan.comparedOffers) &&
      plan.comparedOffers.length === canonicalPlan.comparedOffers.length &&
      plan.comparedOffers.every((offer, index) => {
        const record = objectRecord(offer);
        const canonicalOffer = canonicalPlan.comparedOffers[index];
        return Boolean(
          record &&
            offerFields.every(
              (field) => record[field] === canonicalOffer[field],
            ),
        );
      }),
  );
}

function completeV2CommercialArithmetic(result, product) {
  const hasSupplierPlan = result.supplierPlan !== undefined;
  if (!product) return result.product === null && !hasSupplierPlan;
  if (product.total !== product.requestedKg * product.pricePerKg) return false;

  const market = objectRecord(result.market);
  const marketItems = Array.isArray(market?.items) ? market.items : [];
  const plan = hasSupplierPlan ? objectRecord(result.supplierPlan) : null;
  const category = completeText(plan?.category)
    ? plan.category
    : "agent-result-market";
  const canonicalPlan = buildSupplierPlan(
    {
      category,
      stockKg: product.stockKg,
      pricePerKg: product.pricePerKg,
    },
    marketItems.map((item) => ({
      category,
      competitor: item?.competitor,
      pricePerKg: item?.pricePerKg,
      deliveryDays: item?.deliveryDays,
      checkedAt: item?.checkedAt,
      stockKg: item?.stockKg,
      stockCheckedAt: item?.stockCheckedAt,
    })),
    product.requestedKg,
  );

  if (!canonicalPlan) return !hasSupplierPlan;
  if (!plan || product.requestedKg <= product.stockKg) return false;

  const ownKg = Math.min(product.requestedKg, product.stockKg);
  return Boolean(
    plan.ourKg + plan.supplierKg === product.requestedKg &&
      plan.supplierKg === product.requestedKg - ownKg &&
      plan.supplierStockKg >= plan.supplierKg &&
      plan.ourSubtotal === plan.ourKg * plan.ourPricePerKg &&
      plan.supplierSubtotal ===
        plan.supplierKg * plan.supplierPricePerKg &&
      plan.total === plan.ourSubtotal + plan.supplierSubtotal &&
      matchesCanonicalSupplierPlan(plan, canonicalPlan)
  );
}

const resolvedAskIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function requestGroundedByMessage(request, evidenceItems) {
  const normalizedRequest = normalizedEvidenceText(request);
  if (!normalizedRequest) return false;
  return evidenceItems.some((item) => {
    const quote = normalizedEvidenceText(item?.source?.quote);
    if (!quote) return false;
    if (quote.includes(normalizedRequest)) return true;
    const requestRoots = askScopeRoots(normalizedRequest);
    const quoteRoots = new Set(askScopeRoots(quote));
    return requestRoots.length > 0 && requestRoots.every((root) => quoteRoots.has(root));
  });
}

function legacyResolvedAsk(intent, evidence, request = "") {
  const messageEvidence = evidence
    .filter((item) => item?.source?.kind === "message")
    .sort(
      (left, right) =>
        Number(right?.source?.roundNo ?? 0) - Number(left?.source?.roundNo ?? 0),
    )
    .slice(0, 4);
  if (!messageEvidence.length) return null;
  const preferredRequest = cleanSemanticCopy(request).slice(0, 240);
  const groundedPreferred =
    preferredRequest &&
    requestGroundedByMessage(preferredRequest, messageEvidence);
  const legacyRequest = cleanSemanticCopy(
    groundedPreferred
      ? preferredRequest
      : messageEvidence[0].source.quote || intent?.goal,
  ).slice(0, 240);
  return legacyRequest
    ? {
        id: "legacy-request",
        request: legacyRequest,
        evidenceIds: [messageEvidence[0].id],
      }
    : null;
}

function normalizeResolvedAsks(value, evidence, {
  allowLegacy = false,
  legacyRequest = "",
  intent = null,
} = {}) {
  const legacyAsks = () => {
    const legacy = allowLegacy
      ? legacyResolvedAsk(intent, evidence, legacyRequest)
      : null;
    return legacy ? [legacy] : null;
  };
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    return legacyAsks();
  }
  const messageEvidence = new Map(
    evidence
      .filter((item) => item?.source?.kind === "message")
      .map((item) => [item.id, item]),
  );
  const seen = new Set();
  const asks = value.map((item) => {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const rawRequest = typeof item?.request === "string" ? item.request.trim() : "";
    const request = cleanSemanticCopy(rawRequest);
    const evidenceIds = Array.isArray(item?.evidenceIds)
      ? [...new Set(item.evidenceIds.map((entry) => cleanIdentifier(entry)).filter(Boolean))]
      : [];
    const evidenceItems = evidenceIds
      .map((evidenceId) => messageEvidence.get(evidenceId))
      .filter(Boolean);
    if (
      !resolvedAskIdPattern.test(id) ||
      seen.has(id) ||
      rawRequest.length < 3 ||
      rawRequest.length > 240 ||
      !request ||
      evidenceIds.length < 1 ||
      evidenceIds.length > 4 ||
      evidenceItems.length !== evidenceIds.length ||
      !requestGroundedByMessage(request, evidenceItems)
    ) {
      return null;
    }
    seen.add(id);
    return { id, request, evidenceIds };
  });
  return asks.every(Boolean) ? asks : legacyAsks();
}

function completeV2Contract(result) {
  if (result.schemaVersion !== 2) return true;
  const intent = objectRecord(result.resolvedIntent);
  const target = objectRecord(intent?.target);
  const evidence = Array.isArray(intent?.evidence) ? intent.evidence : [];
  const assumptions = Array.isArray(intent?.assumptions)
    ? intent.assumptions
    : null;
  const estimates = Array.isArray(result.estimates) ? result.estimates : null;
  const supplierLeads = Array.isArray(result.supplierLeads)
    ? result.supplierLeads
    : null;
  const research =
    result.research === undefined ? undefined : objectRecord(result.research);
  const evidenceIds = new Set(
    evidence.map((item) => cleanIdentifier(item?.id)).filter(Boolean),
  );
  const claimEvidenceIds = new Set(
    evidence
      .filter((item) => !isNeutralOpenedEvidence(item))
      .map((item) => cleanIdentifier(item?.id))
      .filter(Boolean),
  );
  const asks = normalizeResolvedAsks(intent?.asks, evidence);
  const asksAreComplete = Boolean(
    asks && asks.length === intent?.asks?.length,
  );
  const referencedEvidenceIsComplete = (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (id) => cleanIdentifier(id) && claimEvidenceIds.has(cleanIdentifier(id)),
    );
  const evidenceIsComplete =
    evidence.length > 0 &&
    evidenceIds.size === evidence.length &&
    evidence.every((item) => {
      const source = objectRecord(item?.source);
      const sourceIsComplete =
        source?.kind === "message"
          ? Number.isSafeInteger(Number(source.roundNo)) &&
            Number(source.roundNo) >= 1 &&
            completeText(source.quote)
          : source?.kind === "vision"
            ? completeText(source.attachmentRef) &&
              completeText(source.observation) &&
              !containsPersonalInference(source.observation)
          : source?.kind === "web"
         ? (() => {
             const verifiedExcerpt = verifiedOpenedExcerpt(
               source.excerpt,
               source.sha256,
             );
             return Boolean(canonicalPublicHttpsUrl(source.url)) &&
               completeText(source.title) &&
               completeText(source.openedAt) &&
               (isNeutralOpenedEvidence(item)
                 ? !source.excerpt || Boolean(verifiedExcerpt)
                 : Boolean(verifiedExcerpt));
           })()
              : source?.kind === "snapshot"
                ? ["catalog", "inventory", "supplier"].includes(
                    source.dataset,
                  ) &&
                  completeText(source.key) &&
                  completeText(source.version) &&
                  completeText(source.checkedAt)
                : false;
      return (
        completeText(item?.claim) &&
        (!containsUnsupportedPersonalInference(item.claim) ||
          allowsGroundedWebPersonalReference(
            item.claim,
            source,
            target?.label,
            { evidence },
          )) &&
        confidence(item?.confidence) !== null &&
        sourceIsComplete
      );
    });
  const openedWebEvidence = evidence
    .map((item) => {
      const source = objectRecord(item?.source);
      const url = canonicalPublicHttpsUrl(source?.url);
      const openedAt = cleanSourceText(source?.openedAt, 80);
      const hasExcerpt = Boolean(
        verifiedOpenedExcerpt(source?.excerpt, source?.sha256),
      );
      return source?.kind === "web" && url && openedAt
        ? {
            url,
            openedAt,
            hasExcerpt,
            ...(verifiedOpenedExcerpt(source?.excerpt, source?.sha256) ?? {}),
          }
        : null;
    })
    .filter(Boolean);
  const researchSourcesAreComplete =
    research === undefined ||
    (research !== null &&
      Array.isArray(research.sources) &&
      research.sources.every((source) => {
        const url = canonicalPublicHttpsUrl(source?.url);
        const openedSource = openedWebEvidence.find(
          (evidenceSource) =>
            comparableHttpUrl(evidenceSource.url) === comparableHttpUrl(url) &&
            evidenceSource.hasExcerpt,
        );
        return Boolean(
          url &&
            openedSource &&
            (!containsUnsupportedPersonalInference(
              source?.fact,
              target?.label,
            ) ||
              allowsGroundedWebPersonalReference(
                source?.fact,
                {
                  kind: "web",
                  url,
                  title: source?.title,
                  openedAt: source?.checkedAt,
                  excerpt: openedSource.excerpt,
                  sha256: openedSource.sha256,
                },
                target?.label,
                { evidence },
              )),
        );
      }));
  const normalizedAssumptions =
    assumptions === null
      ? []
      : normalizeAssumptions(assumptions, claimEvidenceIds);
  const assumptionsAreComplete =
    assumptions !== null &&
    normalizedAssumptions.length === assumptions.length;
  const ambiguous = target?.state === "ambiguous";
  const resolved = target?.state === "resolved";
  const blocker = objectRecord(intent?.blocker);
  const targetIsComplete = resolved
    ? completeText(target.label) &&
      !containsUnsupportedPersonalInference(target.label, target.label) &&
      referencedEvidenceIsComplete(target.evidenceIds) &&
      intent.blocker === null
    : ambiguous &&
      Array.isArray(target.candidates) &&
      target.candidates.length >= 2 &&
      target.candidates.every(
        (candidate) =>
          completeText(candidate?.label) &&
          !containsUnsupportedPersonalInference(candidate.label, candidate.label) &&
          confidence(candidate?.confidence) !== null &&
          referencedEvidenceIsComplete(candidate.evidenceIds),
      ) &&
      blocker?.kind === "target_ambiguity" &&
      completeText(blocker.question) &&
      !containsPersonalInference(blocker.question) &&
      (blocker.question.match(/\?/gu) ?? []).length === 1 &&
      Array.isArray(blocker.choices) &&
      blocker.choices.length === target.candidates.length &&
      blocker.choices.every((choice, index) => {
        const candidateRoots = lexicalRoots(target.candidates[index]?.label);
        const choiceRoots = new Set(lexicalRoots(choice));
        return (
          completeText(choice) &&
          !containsUnsupportedPersonalInference(choice, choice) &&
          candidateRoots.some((root) => choiceRoots.has(root)) &&
          [...choiceRoots].every((root) => candidateRoots.includes(root)) &&
          blocker.question.includes(choice)
        );
      });
  const missing = ambiguous ? [blocker.question] : [];
  const normalizedEstimates = estimates
    ? normalizeEstimates(estimates, intent, null, {
        enforceCatalogCompatibility: false,
      })
    : [];
  const openedSourceUrls = supplierLeads
    ? supplierLeads.map((item) => item?.url)
    : [];
  const normalizedSupplierLeads = supplierLeads
    ? normalizeSupplierLeads(supplierLeads, {
        openedSourceUrls,
        openedSources: openedWebEvidence.filter((source) => source.hasExcerpt),
      })
    : [];
  const supplierLeadKeys = new Set([
    "supplier",
    "url",
    "openedAt",
    "observedClaims",
    "confirmationNeeded",
  ]);
  const supplierLeadShapeIsComplete =
    supplierLeads !== null &&
    supplierLeads.every((lead) => {
      const record = objectRecord(lead);
      return (
        record &&
        Object.keys(record).every((key) => supplierLeadKeys.has(key))
      );
    });
  const estimatesAreComplete =
    estimates !== null && normalizedEstimates.length === estimates.length;
  const supplierLeadsAreComplete =
    supplierLeadShapeIsComplete &&
    normalizedSupplierLeads.length === supplierLeads.length &&
    supplierLeads.every((lead) => {
      const url = canonicalPublicHttpsUrl(lead?.url);
      const openedAt = cleanSourceText(lead?.openedAt, 80);
      return Boolean(
        url &&
          openedAt &&
          openedWebEvidence.some((evidenceSource) =>
            comparableHttpUrl(evidenceSource.url) === comparableHttpUrl(url) &&
            evidenceSource.hasExcerpt,
          ),
      );
    });
  const product = objectRecord(result.product);
  const commercialArithmeticIsComplete = completeV2CommercialArithmetic(
    result,
    product,
  );
  const routeMatches =
    result.zone === "red" &&
    result.decision === "escalate" &&
    result.route === "manager" &&
    result.commitment === "none" &&
    product === null &&
    estimates?.length === 0
      ? true
      : ambiguous
      ? result.zone === "yellow" &&
        result.decision === "clarify" &&
        result.route === "needs_info" &&
        result.commitment === "none" &&
        product === null &&
        result.calculation === undefined &&
        estimates?.length === 0
      : result.commitment === "estimate"
        ? product === null &&
          estimates?.length > 0 &&
          ((result.zone === "yellow" &&
            result.decision === "clarify" &&
            result.route === "ready") ||
            (result.zone === "red" &&
              result.decision === "escalate" &&
              result.route === "manager"))
        : result.commitment === "commercial_offer"
          ? product &&
            ((result.zone === "green" &&
              result.decision === "quote" &&
              result.route === "ready" &&
              product.requestedKg <= product.stockKg) ||
            (result.zone === "red" &&
              result.decision === "escalate" &&
              result.route === "manager" &&
              product.requestedKg > product.stockKg))
          : false;
  return Boolean(
    intent &&
      completeText(intent.goal) &&
      !containsUnsupportedPersonalInference(intent.goal, target?.label) &&
      asksAreComplete &&
      evidenceIsComplete &&
      assumptionsAreComplete &&
      targetIsComplete &&
      researchSourcesAreComplete &&
      routeMatches &&
      commercialArithmeticIsComplete &&
      ["none", "estimate", "commercial_offer"].includes(result.commitment) &&
      estimates &&
      supplierLeads &&
      estimatesAreComplete &&
      supplierLeadsAreComplete &&
      JSON.stringify(result.missing) === JSON.stringify(missing) &&
      (result.visionObservation === null ||
        Boolean(normalizeVisionObservation(result.visionObservation))),
  );
}

export function isCompleteAgentResult(value) {
  const result = objectRecord(value);
  if (!result || hasSensitiveDraftText(result)) return false;

  const expected = {
    green: { decision: "quote", route: "ready" },
    yellow: { decision: "clarify", route: "needs_info" },
    red: { decision: "escalate", route: "manager" },
  }[result.zone];
  if (
    !expected ||
    result.decision !== expected.decision ||
    (result.schemaVersion !== 2 && result.route !== expected.route) ||
    !completeV2Contract(result)
  ) {
    return false;
  }

  const reply = objectRecord(result.reply);
  const market = objectRecord(result.market);
  const review = objectRecord(result.review);
  const product =
    result.product === null ? null : objectRecord(result.product);
  const research =
    result.research === undefined ? undefined : objectRecord(result.research);
  const options = Array.isArray(result.options) ? result.options : null;
  const decisionBasis = Array.isArray(result.decisionBasis)
    ? result.decisionBasis
    : null;

  const optionsComplete =
    options &&
    options.every((value) => {
      const option = objectRecord(value);
      return Boolean(
        option &&
          completeText(option.id) &&
          completeText(option.title) &&
          completeText(option.rationale) &&
          completeText(option.tradeoff) &&
          completeText(option.reply) &&
          (result.schemaVersion !== 2 ||
            ["customer", "supplier", "internal", "none"].includes(
              option.followUpActor,
            )),
      );
    });
  const optionCountMatchesRoute =
    result.route === "manager"
      ? options && options.length >= 2 && options.length <= 3
      : options && options.length === 0;
  const availableKg = completeNumber(product?.availableKg)
    ? product.availableKg
    : product?.stockKg;
  const shortageWithResolvedTarget = Boolean(
    result.schemaVersion === 2 &&
      result.resolvedIntent?.blocker === null &&
      product &&
      completeNumber(product.requestedKg) &&
      completeNumber(availableKg) &&
      product.requestedKg > availableKg,
  );
  const shortageActorsAreComplete =
    !shortageWithResolvedTarget ||
    Boolean(
      options &&
        options.every((option) =>
          ["supplier", "internal", "none"].includes(option?.followUpActor),
        ),
    );
  const understoodTargetLabel = result.resolvedIntent?.target?.label ?? "";
  return Boolean(
    completeNumber(result.confidence) &&
      result.confidence <= 1 &&
      completeStringList(result.understood, { allowEmpty: false }) &&
      result.understood.every(
        (item) =>
          !containsUnsupportedPersonalInference(
            item,
            understoodTargetLabel,
          ),
      ) &&
      completeStringList(result.missing) &&
      (result.route !== "needs_info" || result.missing.length > 0) &&
      completeStringList(result.checks, { allowEmpty: false }) &&
      completeStringList(result.sources, { allowEmpty: false }) &&
      completeText(result.businessContext) &&
      completeText(result.zoneReason) &&
      completeText(result.managerNote) &&
      reply &&
      completeText(reply.subject) &&
      completeText(reply.body) &&
      market &&
      typeof market.checked === "boolean" &&
      completeText(market.summary) &&
      completeText(market.position) &&
      completeText(market.profitOpportunity) &&
      Array.isArray(market.items) &&
      market.items.every((value) => {
        const item = objectRecord(value);
        return Boolean(
          item &&
            completeText(item.competitor) &&
            completeNumber(item.pricePerKg, 0.01) &&
            completeNumber(item.deliveryDays) &&
            completeText(item.checkedAt),
        );
      }) &&
      review &&
      completeText(review.model) &&
      completeText(review.verdict) &&
      completeStringList(review.notes) &&
      optionsComplete &&
      optionCountMatchesRoute &&
      shortageActorsAreComplete &&
      decisionBasis &&
      decisionBasis.length > 0 &&
      decisionBasis.every((value) => {
        const basis = objectRecord(value);
        return Boolean(
          basis &&
            completeText(basis.fact) &&
            completeText(basis.source) &&
            completeText(basis.checkedAt) &&
            (basis.stockVersion === undefined ||
              typeof basis.stockVersion === "string"),
        );
      }) &&
      (product === null ||
        (completeText(product.sku) &&
          completeText(product.name) &&
          completeNumber(product.stockKg) &&
          completeNumber(product.requestedKg) &&
          completeNumber(product.pricePerKg, 0.01) &&
          completeNumber(product.total) &&
          completeNumber(product.replenishmentDays))) &&
      (result.route !== "ready" ||
        product !== null ||
        (result.schemaVersion === 2 && result.commitment === "estimate")) &&
      completeCalculation(result.calculation) &&
      (research === undefined ||
        (typeof research.checked === "boolean" &&
          typeof research.summary === "string" &&
          Array.isArray(research.sources) &&
          research.sources.every((value) => {
            const source = objectRecord(value);
            return Boolean(
                source &&
                completeText(source.title) &&
                completeText(canonicalPublicHttpsUrl(source.url)) &&
                completeText(source.checkedAt) &&
                completeText(source.fact),
            );
          }))),
  );
}

function finiteNumber(value, minimum = 0) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= minimum
    ? candidate
    : null;
}

function normalizeCalculation(value) {
  if (!value || typeof value !== "object" || value.kind !== "fence-area") {
    return undefined;
  }
  const material = ["дерево", "металл"].includes(value.material)
    ? value.material
    : "";
  const areaPerSideM2 = finiteNumber(value.areaPerSideM2, 0.01);
  const sides = finiteNumber(value.sides, 1);
  const paintAreaM2 = finiteNumber(value.paintAreaM2, 0.01);
  const coverageKgPerM2PerCoat = finiteNumber(
    value.coverageKgPerM2PerCoat,
    0.01,
  );
  const coats = finiteNumber(value.coats, 1);
  const reservePercent = finiteNumber(value.reservePercent, 0);
  const estimatedKg = finiteNumber(value.estimatedKg, 0.01);
  const packageKg = finiteNumber(value.packageKg, 0.01);
  const packages = finiteNumber(value.packages, 1);
  const roundedKg = finiteNumber(value.roundedKg, 0.01);
  const explanation = cleanCopy(value.explanation);
  if (
    !material ||
    areaPerSideM2 === null ||
    sides === null ||
    paintAreaM2 === null ||
    coverageKgPerM2PerCoat === null ||
    coats === null ||
    reservePercent === null ||
    estimatedKg === null ||
    packageKg === null ||
    packages === null ||
    roundedKg === null ||
    !explanation
  ) {
    return undefined;
  }
  return {
    kind: "fence-area",
    material,
    lengthM: finiteNumber(value.lengthM, 0.01),
    heightM: finiteNumber(value.heightM, 0.01),
    areaPerSideM2,
    sides,
    paintAreaM2,
    coverageKgPerM2PerCoat,
    coats,
    reservePercent,
    estimatedKg,
    packageKg,
    packages,
    roundedKg,
    explanation,
  };
}

function normalizeDecisionBasis(value) {
  return Array.isArray(value)
    ? value
        .map((basis) => ({
          fact: cleanCopy(basis?.fact).slice(0, 420),
          source: cleanCopy(basis?.source).slice(0, 180),
          checkedAt: cleanSourceText(basis?.checkedAt, 80),
          stockVersion: cleanSourceText(basis?.stockVersion, 100),
        }))
        .filter((basis) => basis.fact && basis.source && basis.checkedAt)
        .slice(0, 6)
    : [];
}

function safeHttpUrl(value) {
  if (containsCredentialText(value)) return "";
  try {
    const url = new URL(text(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function comparableHttpUrl(value) {
  const url = safeHttpUrl(value);
  return url ? url.replace(/#.*$/, "").replace(/\/$/, "") : "";
}

function canonicalPublicHttpsUrl(value) {
  try {
    const url = new URL(text(value));
    if (url.protocol !== "https:" || url.username || url.password) return "";
    const hash = url.hash;
    url.hash = "";
    return `${url.toString().replace(/\/$/u, "")}${hash}`;
  } catch {
    return "";
  }
}

function verifiedOpenedExcerpt(excerpt, sha256) {
  const bounded = cleanSourceText(excerpt, MAX_OPENED_SOURCE_EXCERPT_CHARS);
  const digest = cleanSourceText(sha256, 64).toLowerCase();
  return bounded &&
    /^[a-f0-9]{64}$/u.test(digest) &&
    createHash("sha256").update(bounded, "utf8").digest("hex") === digest
    ? { excerpt: bounded, sha256: digest }
    : null;
}

function openedSourceUrlSet(job) {
  return new Set(
    [
      ...(Array.isArray(job?.openedSourceUrls) ? job.openedSourceUrls : []),
      ...(Array.isArray(job?.openedSources)
        ? job.openedSources.map((item) => item?.url)
        : []),
    ]
      .map(comparableHttpUrl)
      .filter(Boolean),
  );
}

function openedSourceRecords(job) {
  const openedUrls = openedSourceUrlSet(job);
  const rawRecords = Array.isArray(job?.openedSources)
    ? job.openedSources
    : (Array.isArray(job?.openedSourceUrls) ? job.openedSourceUrls : []).map(
        (url) => ({ url, openedAt: "текущий запуск" }),
      );
  const seen = new Set();
  return rawRecords
    .map((item) => {
      const url = canonicalPublicHttpsUrl(item?.url);
      const comparable = comparableHttpUrl(url);
      const openedAt = cleanSourceText(item?.openedAt, 80);
      const excerpt = cleanSourceText(item?.excerpt, MAX_OPENED_SOURCE_EXCERPT_CHARS);
      const verifiedExcerpt = verifiedOpenedExcerpt(item?.excerpt, item?.sha256);
      if (
        !url ||
        !comparable ||
        !openedAt ||
        !openedUrls.has(comparable) ||
        (excerpt && !verifiedExcerpt) ||
        seen.has(comparable)
      ) {
        return null;
      }
      seen.add(comparable);
      return { url, openedAt, ...(verifiedExcerpt ?? {}) };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function neutralOpenedEvidence(job, existingIds, requestedUrl = "") {
  const comparableRequestedUrl = comparableHttpUrl(requestedUrl);
  const record = openedSourceRecords(job).find(
    (candidate) =>
      !comparableRequestedUrl ||
      comparableHttpUrl(candidate.url) === comparableRequestedUrl,
  );
  if (!record) return null;
  let suffix = 1;
  let id = `opened-web-audit-${suffix}`;
  while (existingIds.has(id)) {
    suffix += 1;
    id = `opened-web-audit-${suffix}`;
  }
  return {
    id,
    claim: openedEvidenceClaim,
    confidence: 0,
    source: {
      kind: "web",
      url: record.url,
      title: "Открытая публичная страница",
      openedAt: record.openedAt,
      ...(record.excerpt ? { excerpt: record.excerpt, sha256: record.sha256 } : {}),
    },
  };
}

function isNeutralOpenedEvidence(value) {
  return value?.source?.kind === "web" && value?.claim === openedEvidenceClaim;
}

function normalizedEvidenceText(value) {
  return text(value)
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/\s+/gu, " ");
}

function evidenceRoots(value) {
  return normalizedEvidenceText(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .map((token) => token.length >= 4 ? token.slice(0, 6) : "")
    .filter((root) => root && !EVIDENCE_STOP_ROOTS.has(root));
}

function excerptSupportsClaim(claim, excerpt) {
  if (!excerpt || hasUntrustedInstructionText(excerpt) || hasUntrustedInstructionText(claim)) return false;
  const claimRoots = new Set(evidenceRoots(claim));
  const excerptRoots = new Set(evidenceRoots(excerpt));
  let overlap = 0;
  for (const root of claimRoots) if (excerptRoots.has(root)) overlap += 1;
  return overlap >= (claimRoots.size > 2 ? 2 : 1);
}

function customerBridgeSupportsClaim(claim, excerpt, title, job) {
  if (
    !claim ||
    !excerpt ||
    !title ||
    hasUntrustedInstructionText(claim) ||
    hasUntrustedInstructionText(excerpt) ||
    hasUntrustedInstructionText(title) ||
    openedUnsupportedClaimPattern.test(claim)
  ) {
    return false;
  }
  const claimRoots = new Set(evidenceRoots(claim));
  const excerptRoots = new Set(evidenceRoots(excerpt));
  const titleRoots = new Set(evidenceRoots(title));
  const customerRoots = new Set(evidenceRoots(latestCustomerText(job)).map(
    (root) => /\p{Script=Cyrillic}/u.test(root) ? root.slice(0, 5) : root,
  ));
  const pageRoots = new Set([...titleRoots, ...excerptRoots]);
  // ponytail: one inflected named-object anchor is enough only with two page anchors.
  return (
    claimRoots.size >= 2 &&
    titleRoots.size >= 2 &&
    [...claimRoots].filter((root) =>
      customerRoots.has(/\p{Script=Cyrillic}/u.test(root) ? root.slice(0, 5) : root),
    ).length >= 1 &&
    [...claimRoots].filter((root) => pageRoots.has(root)).length >= 2 &&
    [...titleRoots].filter((root) => excerptRoots.has(root)).length >= 2
  );
}

function webClaimSupportsExcerpt(claim, excerpt, title, job) {
  const proseClaim = text(claim).replace(/\b[IVXLCDM]+\b/gu, "");
  const claimIsBilingual =
    /\p{Script=Cyrillic}/u.test(text(claim)) &&
    /\p{Script=Latin}/u.test(proseClaim);
  const directSupport =
    !claimIsBilingual &&
    excerptSupportsClaim(claim, excerpt);
  return (
    directSupport || customerBridgeSupportsClaim(claim, excerpt, title, job)
  );
}

function targetGroundingText(job, evidence = []) {
  const messageText = latestCustomerText(job);
  if (messageText) return messageText;
  return evidence
    .filter((item) => item?.source?.kind === "message")
    .map((item) => item.source.quote)
    .filter(Boolean)
    .join(" ");
}

function targetGroundedByMessage(targetLabel, messageText) {
  const messageRoots = lexicalRoots(messageText);
  return lexicalRoots(targetLabel).some((root) => messageRoots.includes(root));
}

function targetGroundedByMessageOrVision(targetLabel, job, evidence = []) {
  if (!isExplicitNonHumanTarget(targetLabel)) return false;
  const targetRoots = new Set(lexicalRoots(targetLabel));
  if (!targetRoots.size) return false;
  const messageText = targetGroundingText(job, evidence);
  if (targetGroundedByMessage(targetLabel, messageText)) {
    return true;
  }
  const storedVision = normalizeVisionObservation(job?.visionObservation);
  const visionText = [
    storedVision?.summary,
    ...(storedVision?.targetCandidates ?? []).flatMap((candidate) => [
      candidate.label,
      candidate.evidence,
    ]),
    ...(storedVision?.visibleFacts ?? []),
    ...evidence
      .filter((item) => item?.source?.kind === "vision")
      .map((item) => item.source.observation),
  ]
    .filter(Boolean)
    .join(" ");
  return [...targetRoots].some((root) => lexicalRoots(visionText).includes(root));
}

function allowsGroundedWebPersonalReference(
  claim,
  source,
  targetLabel = "",
  { job, evidence = [] } = {},
) {
  const verified =
    source?.kind === "web"
      ? verifiedOpenedExcerpt(source.excerpt, source.sha256)
      : null;
  const bridgeJob =
    job && latestCustomerText(job)
      ? job
      : { body: targetGroundingText(job, evidence) };
  return Boolean(
    verified &&
      canonicalPublicHttpsUrl(source.url) &&
      targetGroundedByMessageOrVision(targetLabel, job, evidence) &&
      /\p{Script=Cyrillic}/u.test(text(claim)) &&
      /\p{Script=Latin}/u.test(text(claim)) &&
      customerBridgeSupportsClaim(
        claim,
        verified.excerpt,
        source.title,
        bridgeJob,
      ),
  );
}

function customerConversation(job) {
  if (Array.isArray(job?.conversation)) return job.conversation;
  if (typeof job?.conversationJson !== "string") return [];
  try {
    const parsed = JSON.parse(job.conversationJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function messageTextsByRound(job) {
  const rounds = new Map();
  const initial = [job?.subject, job?.body]
    .map(normalizedEvidenceText)
    .filter(Boolean);
  if (initial.length) rounds.set(1, initial);

  let roundNo = 2;
  for (const message of customerConversation(job)) {
    if (message?.role !== "customer") continue;
    const body = normalizedEvidenceText(message.body ?? message.text);
    if (body) rounds.set(roundNo, [body]);
    roundNo += 1;
  }
  return rounds;
}

function messageQuoteWasProvided(source, job) {
  const quote = normalizedEvidenceText(source?.quote);
  if (!quote) return false;
  const rounds = messageTextsByRound(job);
  if (rounds.size === 0) return true;
  const texts = rounds.get(Number(source?.roundNo)) ?? [];
  return texts.some((candidate) => candidate.includes(quote));
}

function sourceRecordFor(source, job) {
  const url = canonicalPublicHttpsUrl(source?.url);
  const comparable = comparableHttpUrl(url);
  return openedSourceRecords(job).find(
    (record) => comparableHttpUrl(record.url) === comparable,
  ) ?? null;
}

function sourceWasOpened(source, job) {
  const url = canonicalPublicHttpsUrl(source?.url);
  return Boolean(url && openedSourceUrlSet(job).has(comparableHttpUrl(url)));
}

function confidence(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function cleanIdentifier(value, max = 100) {
  const candidate = cleanSourceText(value, max);
  return /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(candidate)
    ? candidate
    : "";
}

function normalizeSnapshotSource(source, demoData) {
  const dataset = ["catalog", "inventory", "supplier"].includes(
    source.dataset,
  )
    ? source.dataset
    : "";
  const key = cleanSourceText(source.key, 140);
  const version = cleanSourceText(source.version, 100);
  const checkedAt = cleanSourceText(source.checkedAt, 80);
  if (!dataset || !key || !version || !checkedAt) return null;
  if (!demoData) return { kind: "snapshot", dataset, key, version, checkedAt };

  const snapshotVersion = String(
    demoData.inventorySnapshot?.version ?? "demo",
  );
  if (version !== snapshotVersion) return null;
  if (dataset === "supplier") {
    const supplier = demoData.market?.find(
      (item) => cleanSourceText(item.competitor, 140) === key,
    );
    return supplier
      ? {
          kind: "snapshot",
          dataset,
          key: cleanSourceText(supplier.competitor, 140),
          version: snapshotVersion,
          checkedAt:
            cleanSourceText(
              supplier.stockCheckedAt ?? supplier.checkedAt,
              80,
            ) || "демонстрационный снимок",
        }
      : null;
  }

  const product = demoData.products?.find(
    (item) => cleanSourceText(item.sku, 140) === key,
  );
  return product
    ? {
        kind: "snapshot",
        dataset,
        key,
        version: snapshotVersion,
        checkedAt:
          cleanSourceText(
            product.stockUpdatedAt ??
              demoData.inventorySnapshot?.capturedAt,
            80,
          ) || "демонстрационный снимок",
      }
    : null;
}

function normalizeEvidenceSource(value, job, demoData) {
  const source = objectRecord(value);
  if (!source) return null;

  if (source.kind === "message") {
    const roundNo = Number(source.roundNo);
    const quote = cleanSourceText(source.quote, 420);
    return Number.isSafeInteger(roundNo) &&
      roundNo >= 1 &&
      quote &&
      messageQuoteWasProvided({ roundNo, quote }, job)
      ? { kind: "message", roundNo, quote }
      : null;
  }

  if (source.kind === "vision") {
    const attachmentRef = cleanSourceText(source.attachmentRef, 240);
    const jobVision = normalizeVisionObservation(job?.visionObservation);
    const observation = [
      jobVision?.summary,
      ...(jobVision?.visibleFacts ?? []),
      ...(jobVision?.scaleEvidence ?? []),
      ...(jobVision?.areaEstimate
        ? [
            `Оценка площади: ${jobVision.areaEstimate.min}–${jobVision.areaEstimate.max} ${jobVision.areaEstimate.unit}`,
          ]
        : []),
      ...(jobVision?.uncertainties ?? []),
    ]
      .filter(Boolean)
      .join(". ")
      .slice(0, 420);
    const matchesStoredObservation =
      !jobVision?.attachmentRef ||
      jobVision.attachmentRef === attachmentRef;
    return attachmentRef &&
      observation &&
      !containsCredentialText(observation) &&
      jobVision?.relevance !== "irrelevant" &&
      matchesStoredObservation
      ? { kind: "vision", attachmentRef, observation }
      : null;
  }

  if (source.kind === "web") {
    const url = canonicalPublicHttpsUrl(source.url);
    const title = safeOpenedSourceTitle(source.title);
    const openedAt = cleanSourceText(source.openedAt, 80);
    const record = sourceRecordFor({ url }, job);
    const excerpt = record?.excerpt ?? "";
    const sha256 = record?.sha256 ?? "";
    return url && title && openedAt && sourceWasOpened({ url }, job)
      ? { kind: "web", url, title, openedAt, ...(excerpt ? { excerpt, sha256 } : {}) }
      : null;
  }

  if (source.kind === "snapshot") {
    return normalizeSnapshotSource(source, demoData);
  }

  return null;
}

function groundedEvidenceClaim(rawClaim, source, demoData, job, targetLabel = "") {
  if (source.kind === "vision") return source.observation;
  if (source.kind === "web") {
    const record = sourceRecordFor(source, job);
    if (
      record?.excerpt &&
      record.sha256 &&
      !webClaimSupportsExcerpt(
        rawClaim,
        record.excerpt,
        source.title,
        job,
      )
    ) return "";
    if (!record?.excerpt || !record.sha256) return openedEvidenceClaim;
    const safeClaim = safeOpenedResearchFact(rawClaim);
    return safeClaim === openedResearchFallback ? "" : safeClaim;
  }
  if (
    source.kind === "message" &&
    containsUnsupportedPersonalInference(rawClaim, targetLabel)
  ) {
    return "";
  }
  if (
    source.kind === "message" &&
    hasUnsupportedNamedAttribution(rawClaim, job, demoData)
  ) {
    // ponytail: a message can prove only what the customer actually wrote.
    return source.quote;
  }
  if (source.kind !== "snapshot" || !demoData) return rawClaim;
  if (source.dataset === "supplier") {
    const supplier = demoData.market?.find(
      (item) => cleanSourceText(item.competitor, 140) === source.key,
    );
    return supplier
      ? `${supplier.competitor}: ${supplier.stockKg} кг, ${supplier.pricePerKg} ₽/кг, срок ${supplier.deliveryDays} дн.`
      : "";
  }
  const product = demoData.products?.find(
    (item) => cleanSourceText(item.sku, 140) === source.key,
  );
  if (!product) return "";
  return source.dataset === "inventory"
    ? `Собственный склад подтверждает ${product.stockKg} кг ${product.sku}`
    : `Каталог подтверждает ${product.sku}: ${product.name}`;
}

function normalizeEvidence(value, job, demoData, targetLabel = "") {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((item) => {
      const id = cleanIdentifier(item?.id);
      const rawClaim = cleanSemanticCopy(item?.claim).slice(0, 420);
      const claimConfidence = confidence(item?.confidence);
      const source = normalizeEvidenceSource(item?.source, job, demoData);
      const claim = source
        ? groundedEvidenceClaim(rawClaim, source, demoData, job, targetLabel)
        : "";
      const groundedWebPersonalReference = allowsGroundedWebPersonalReference(
        claim,
        source,
        targetLabel,
        { job, evidence: value },
      );
      if (
        !id ||
        seen.has(id) ||
        !claim ||
        claimConfidence === null ||
        !source ||
        (containsUnsupportedPersonalInference(claim, targetLabel) &&
          !groundedWebPersonalReference) ||
        ((source.kind === "message" || source.kind === "vision") &&
          containsUnsupportedPersonalInference(rawClaim, targetLabel)) ||
        (source.kind === "vision" &&
          containsPersonalInference(source.observation))
      ) {
        return null;
      }
      seen.add(id);
      return {
        id,
        claim,
        confidence:
          source.kind === "web" && claim === openedEvidenceClaim
            ? 0
            : claimConfidence,
        source,
      };
    })
    .filter(Boolean)
    .slice(0, 16);
}

function normalizeRange(value) {
  const range = objectRecord(value);
  if (!range) return null;
  const min = Number(range.min);
  const max = Number(range.max);
  const unit = cleanSourceText(range.unit, 24);
  return Number.isFinite(min) &&
    Number.isFinite(max) &&
    min >= 0 &&
    max >= min &&
    unit
    ? { min, max, unit }
    : null;
}

function validReferencedIds(
  value,
  validIds,
  { allowEmpty = false, allowSubset = false } = {},
) {
  if (!Array.isArray(value)) return null;
  const rawIds = value.map((item) => cleanIdentifier(item)).filter(Boolean);
  const ids = [...new Set(rawIds)].filter((id) => validIds.has(id));
  return (allowEmpty || ids.length > 0) &&
    (allowSubset || ids.length === value.length) &&
    rawIds.length === value.length
    ? ids
    : null;
}

function normalizeAssumptions(value, evidenceIds) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((item) => {
      const id = cleanIdentifier(item?.id);
      const claim = cleanSemanticCopy(item?.claim).slice(0, 420);
      const basedOnEvidenceIds = validReferencedIds(
        item?.basedOnEvidenceIds,
        evidenceIds,
      );
      const assumptionConfidence = confidence(item?.confidence);
      const range =
        item?.range === undefined ? undefined : normalizeRange(item.range);
      const confirmBefore = [
        "never",
        "commercial_offer",
        "reserve",
        "production",
      ].includes(item?.confirmBefore)
        ? item.confirmBefore
        : "";
      if (
        !id ||
        seen.has(id) ||
        !claim ||
        containsPersonalInference(claim) ||
        !basedOnEvidenceIds ||
        assumptionConfidence === null ||
        (item?.range !== undefined && !range) ||
        !confirmBefore
      ) {
        return null;
      }
      seen.add(id);
      return {
        id,
        claim,
        basedOnEvidenceIds,
        confidence: assumptionConfidence,
        ...(range ? { range } : {}),
        confirmBefore,
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function lexicalRoots(value) {
  return [
    ...new Set(
      (normalizedEvidenceText(value).match(/[\p{L}\p{N}]{3,}/gu) ?? []).map(
        (word) => word.slice(0, Math.min(4, word.length)),
      ),
    ),
  ];
}

function trustedAttributionText(demoData) {
  return [
    demoData?.brand,
    ...(demoData?.products ?? []).flatMap((item) => [item?.sku, item?.name]),
    ...(demoData?.market ?? []).map((item) => item?.competitor),
  ].filter(Boolean).join(" ");
}

const externalAttributionCuePattern =
  /(?:discovery|snippet|search\s+result|поиск\p{L}*|выдач\p{L}*|опознан\p{L}*\s+как|идентифицир\p{L}*\s+как)/iu;

function namedAttributionCandidates(value) {
  const source = text(value);
  return [
    ...(source.matchAll(/[«“"]([^»”"]{2,100})[»”"]/gu)),
    ...(source.matchAll(
      /((?:\p{Lu}[\p{L}\p{M}'’.-]{2,})(?:\s+\p{Lu}[\p{L}\p{M}'’.-]{2,})+)/gu,
    )),
  ].map((match) => match[1]).filter(Boolean);
}

function hasUnsupportedNamedAttribution(value, job, demoData) {
  const source = text(value);
  const trustedRoots = new Set(
    lexicalRoots(`${latestCustomerText(job)} ${trustedAttributionText(demoData)}`),
  );
  const addedRoots = lexicalRoots(source).filter((root) => !trustedRoots.has(root));
  return addedRoots.length > 0 && (
    externalAttributionCuePattern.test(source) ||
    namedAttributionCandidates(source).some((candidate) =>
      lexicalRoots(candidate).some((root) => !trustedRoots.has(root)),
    )
  );
}

function draftHasUnsupportedNamedAttribution(value, job, demoData) {
  const intent = objectRecord(value?.resolvedIntent);
  return [
    intent?.goal,
    ...(Array.isArray(intent?.evidence)
      ? intent.evidence.map((item) => item?.claim)
      : []),
    ...(Array.isArray(intent?.assumptions)
      ? intent.assumptions.map((item) => item?.claim)
      : []),
    ...(Array.isArray(value?.estimates)
      ? value.estimates.map((item) => item?.method)
      : []),
    value?.reply?.subject,
    value?.reply?.body,
  ].some((candidate) =>
    hasUnsupportedNamedAttribution(candidate, job, demoData),
  );
}

function lexicalWords(value) {
  return normalizedEvidenceText(value).match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

const genericHumanCategoryRoots = new Set(
  [
    "человек",
    "люди",
    "person",
    "people",
    "human",
    "individual",
    "man",
    "woman",
    "boy",
    "girl",
    "actor",
    "actress",
    "performer",
  ].flatMap(lexicalRoots),
);

const neutralHumanContextRoots = new Set(
  ["человек", "люди", "person", "people", "human", "individual"].flatMap(
    lexicalRoots,
  ),
);

function specificHumanActionRoots(value) {
  return lexicalWords(value)
    .filter((word) => isHumanTarget(word))
    .flatMap(lexicalRoots)
    .filter((root) => !genericHumanCategoryRoots.has(root));
}

function neutralHumanContextWord(value) {
  return lexicalWords(value).find((word) =>
    lexicalRoots(word).some((root) => neutralHumanContextRoots.has(root)),
  ) || "";
}

// ponytail: short-root matching tolerates inflected negation without an object parser.
function strongLexicalRootOverlap(candidateWord, messageWord) {
  const rootLength = Math.min(4, candidateWord.length, messageWord.length);
  if (rootLength < 3 || candidateWord.slice(0, rootLength) !== messageWord.slice(0, rootLength)) {
    return false;
  }
  if (candidateWord === messageWord || candidateWord.startsWith(messageWord) || messageWord.startsWith(candidateWord)) {
    return true;
  }
  return (
    candidateWord.slice(rootLength).length <= 2 &&
    messageWord.slice(rootLength).length <= 2
  );
}

function latestCustomerText(job) {
  const rounds = messageTextsByRound(job);
  return [...rounds.entries()]
    .sort(([left], [right]) => right - left)
    .map(([, texts]) => texts.join("\n"))
    .find(Boolean) || "";
}

const askMarkerPattern =
  /(?:(?<!\p{L})(?:хочу|нужн\p{L}*|прос\p{L}*|скаж\p{L}*|подскаж\p{L}*|сколько|как\p{L}*|что|где|когда|можно|стоит)(?!\p{L})|покрас\p{L}*|перекрас\p{L}*|окрас\p{L}*|обработ\p{L}*|покры\p{L}*|подб\p{L}*|рассчит\p{L}*|посчит\p{L}*|оцен\p{L}*|посовет\p{L}*|выб\p{L}*|обнов\p{L}*|пришл\p{L}*|отправ\p{L}*|покаж\p{L}*|каталог\p{L}*|(?<!\p{L})(?:want|need|please|how\s+much|what|which|paint|coat|choose|estimate|calculate)(?!\p{L}))/iu;
const askCostRequestPattern =
  /(?:сколько[^.!?;\n]{0,80}(?:стоит|стоить|обойд(?:е|ё)тся)|стоимост\p{L}*|бюджет\p{L}*|(?:^|[^\p{L}])цен(?:а|ы|у|е|ой)(?=$|[^\p{L}])|\b(?:how\s+much|cost|budget|price)\b)/iu;
const explicitPaintRequestPattern =
  /(?:покрас\p{L}*|перекрас\p{L}*|окрас\p{L}*|\b(?:paint|coat)\b)/iu;
const askColorRequestPattern =
  /(?:како\p{L}*\s+цвет|цвет\p{L}*\s+(?:выб|подобр|посовет)|(?:рекоменд|посовет|подб)\p{L}*[^.!?\n]{0,60}цвет\p{L}*|палитр\p{L}*|оттен\p{L}*|\b(?:color|colour|palette|shade)\b)/iu;
const colorRecommendationPattern =
  /(?:рекоменд|посовет|совет(?:ую|уем|уете|уют|овал\p{L}*|овать)|выбрал|выбран|выбрать|выбир\p{L}*|предпоч|практичн|лучше|сохран\p{L}*[^.!?\n]{0,60}(?:палитр|цвет)|\b(?:recommend|choose|prefer|practical)\b|preserv\p{L}*[^.!?\n]{0,60}palette)/iu;
const colorChoicePattern =
  /(?:коричнев|зел[её]н|бел|красн|сер|ч[её]рн|палитр|оттен|\bRAL\b|\bcolou?r\b|\bshade\b)/iu;
const colorHeadingPattern =
  /^(?:цвет|палитр|оттен)\p{L}*(?:\s+для)?(?:\s|$)/iu;
const askCatalogRequestPattern =
  /(?:каталог\p{L}*|артикул\p{L}*|sku|какую\s+краск\p{L}*|како\p{L}*\s+покрыт\p{L}*|\b(?:catalog|product)\b)/iu;
const askCoverageStopRoots = new Set(
  [
    "оценить",
    "покрасить",
    "окрасить",
    "краска",
    "покрытие",
    "мысленный",
    "сценарий",
    "задача",
    "запрос",
    "заказ",
    "крупный",
    "реальный",
    "отдельно",
    "подготовить",
    "выполнимый",
    "дать",
    "дайте",
    "диапазон",
    "стоимость",
    "бюджет",
    "цвет",
    "выбрать",
    "сказать",
    "скажите",
    "сколько",
    "будет",
    "стоить",
    "ещё",
    "лучше",
    "помочь",
    "определить",
    "клиент",
    "хочу",
    "нужно",
    "просить",
    "подсказать",
    "можно",
    "какой",
    "что",
    "где",
    "когда",
    "без",
    "для",
    "это",
    "этот",
    "обновить",
    "подобрать",
    "посчитать",
    "рассчитать",
    "прислать",
    "отправить",
    "показать",
    "каталог",
    "артикул",
    "товар",
    "расход",
    "estimate",
    "paint",
    "scenario",
    "cost",
    "color",
    "colour",
  ].flatMap(lexicalRoots),
);
const askCoverageActionRoots = new Set(["подберите"].flatMap(lexicalRoots));

function coordinatedActionParts(part) {
  const match = part.match(
    /^(.*?(?:покрас\p{L}*|перекрас\p{L}*|окрас\p{L}*|обработ\p{L}*|покры\p{L}*)(?=\s|$))\s+(.+)$/iu,
  );
  if (!match) return [part];
  const objects = match[2]
    .split(/\s+и\s+/iu)
    .map((item) => cleanSemanticCopy(item).slice(0, 180))
    .filter(Boolean);
  return objects.length === 2 && objects.every((item) => item.length <= 100)
    ? objects.map((item) => `${match[1]} ${item}`.slice(0, 240))
    : [part];
}

function explicitRequestParts(value) {
  return cleanSemanticCopy(value)
    .split(/[.!?;\n]+/u)
    .flatMap((part) =>
      part.split(
        /\s*,?\s+(?:и\s+ещ[её]|а\s+ещ[её]|а\s+также|кроме\s+того|плюс|(?:и|а)\s+(?=(?:сколько|как\p{L}*|что|где|когда|подскаж\p{L}*|скаж\p{L}*|посовет\p{L}*|бюджет\p{L}*|стоимост\p{L}*|цен\p{L}*|расход\p{L}*|каталог\p{L}*|срок\p{L}*|пришл\p{L}*|отправ\p{L}*|покаж\p{L}*|подб\p{L}*|посчит\p{L}*|оцен\p{L}*)))/iu,
      ),
    )
    .map((part) => cleanSemanticCopy(part).slice(0, 240))
    .filter((part) => part.length >= 3 && askMarkerPattern.test(part))
    .flatMap(coordinatedActionParts)
    .slice(0, 6);
}

function askKind(request) {
  if (askCostRequestPattern.test(request)) return "budget";
  if (askColorRequestPattern.test(request)) return "color";
  if (askCatalogRequestPattern.test(request)) return "catalog";
  return "general";
}

function askScopeRoots(request) {
  return [...new Set(
    lexicalRoots(request).filter((root) => !askCoverageStopRoots.has(root)),
  )];
}

function priorAmbiguousTargetRoots(job) {
  if (typeof job?.resultJson !== "string") return new Set();
  try {
    const intent = JSON.parse(job.resultJson)?.resolvedIntent;
    if (
      intent?.target?.state !== "ambiguous" ||
      intent?.blocker?.kind !== "target_ambiguity"
    ) {
      return new Set();
    }
    return new Set(lexicalRoots([
      ...(intent.target.candidates ?? []).map((candidate) => candidate?.label),
      ...(intent.blocker.choices ?? []),
    ].filter(Boolean).join(" ")));
  } catch {
    return new Set();
  }
}

export function askCoverageGaps(job, result) {
  const authored = Array.isArray(result?.resolvedIntent?.asks)
    ? result.resolvedIntent.asks.map((ask) => cleanSemanticCopy(ask?.request))
    : [];
  const descriptor = (request) => ({
    request,
    kind: askKind(request),
    scopeRoots: askScopeRoots(request),
    paintRequest: explicitPaintRequestPattern.test(request),
  });
  const descriptorKey = ({ request, kind, scopeRoots }) =>
    `${kind}:${scopeRoots.slice().sort().join(" ") || normalizedEvidenceText(request)}`;
  const authoredDescriptors = authored.filter(Boolean).map(descriptor);
  const authoredKeys = new Set(authoredDescriptors.map(descriptorKey));
  const authoredCovers = (ask) => {
    if (authoredKeys.has(descriptorKey(ask))) return true;
    const requiredFacets = [
      askCostRequestPattern.test(ask.request) ? askCostRequestPattern : null,
      askColorRequestPattern.test(ask.request) ? askColorRequestPattern : null,
      askCatalogRequestPattern.test(ask.request) ? askCatalogRequestPattern : null,
    ].filter(Boolean);
    if (
      !requiredFacets.every((pattern) =>
        authoredDescriptors.some((candidate) => pattern.test(candidate.request)),
      )
    ) {
      return false;
    }
    const compatible = authoredDescriptors.filter(
      (candidate) => ask.kind === "general" || candidate.kind === ask.kind,
    );
    if (ask.scopeRoots.length === 0) return compatible.length > 0;
    const authoredRoots = new Set(
      compatible.flatMap((candidate) => candidate.scopeRoots),
    );
    const matchedRoots = ask.scopeRoots.filter((root) => authoredRoots.has(root));
    const collectiveRoots = new Set(
      authoredDescriptors.flatMap((candidate) => candidate.scopeRoots),
    );
    const collectiveMatches = ask.scopeRoots.filter((root) =>
      collectiveRoots.has(root),
    );
    const sufficientlyMatched = (matched) =>
      matched.length === ask.scopeRoots.length ||
      (ask.scopeRoots.length >= 3 && matched.length === ask.scopeRoots.length - 1);
    return ask.scopeRoots.length > 0 && (
      sufficientlyMatched(matchedRoots) ||
      (compatible.length > 0 && sufficientlyMatched(collectiveMatches))
    );
  };
  const candidates = [...authored, ...explicitRequestParts(latestCustomerText(job))]
    .filter(Boolean)
    .map(descriptor);
  const byKey = new Map();
  for (const ask of candidates) {
    const key = descriptorKey(ask);
    const existing = byKey.get(key);
    if (existing) existing.paintRequest ||= ask.paintRequest;
    else byKey.set(key, ask);
  }
  const asks = [...byKey.values()].slice(0, 6);
  if (!asks.length) return [];

  const uncoveredAsks = asks.filter((ask) => !authoredCovers(ask));
  if (
    result?.resolvedIntent?.target?.state === "ambiguous" &&
    result?.resolvedIntent?.blocker?.kind === "target_ambiguity"
  ) {
    return uncoveredAsks.map(({ request }) => request).slice(0, 6);
  }

  const visibleText = [
    result?.reply?.body,
    ...(Array.isArray(result?.options)
      ? result.options.flatMap((option) => [
          option?.title,
          option?.rationale,
          option?.reply,
        ])
      : []),
  ].filter(Boolean).join(" ");
  const visibleRoots = new Set(lexicalRoots(visibleText));
  const hasVisibleAnswer = normalizedEvidenceText(visibleText).length > 0;
  const priorTargetRoots = priorAmbiguousTargetRoots(job);
  const resolvedTargetRoots = new Set(
    lexicalRoots(result?.resolvedIntent?.target?.label),
  );
  const inheritsResolvedTargetAsk = ({ kind, scopeRoots }) =>
    kind === "general" &&
    result?.resolvedIntent?.target?.state === "resolved" &&
    scopeRoots.some(
      (root) => priorTargetRoots.has(root) && resolvedTargetRoots.has(root),
    );
  const budgetMethodRoots = (Array.isArray(result?.estimates)
    ? result.estimates
    : []
  )
    .filter((estimate) => estimate?.metric === "budget")
    .map((estimate) => new Set(lexicalRoots(estimate?.method)));
  const colorGuidanceParts = visibleText
    .split(/[.!?\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const colorGuidanceRoots = colorGuidanceParts
    .map((part, index) =>
      part.length <= 100 &&
      colorHeadingPattern.test(part) &&
      !(
        colorRecommendationPattern.test(part) && colorChoicePattern.test(part)
      )
        ? `${part} ${colorGuidanceParts[index + 1] ?? ""}`
        : part,
    )
    .filter(
      (part) =>
        colorRecommendationPattern.test(part) && colorChoicePattern.test(part),
    )
    .map((part) => new Set(lexicalRoots(part)));
  const hasColorGuidance = colorGuidanceRoots.length > 0;
  const colorTargetScopes = asks
    .filter(
      ({ kind, paintRequest, scopeRoots }) =>
        kind !== "color" && paintRequest && scopeRoots.length > 0,
    )
    .map(({ scopeRoots }) => scopeRoots);
  const hasColorGuidanceFor = (scopeRoots) => {
    if (!hasColorGuidance) return false;
    const requiredScopes =
      scopeRoots.length === 0 && colorTargetScopes.length > 1
        ? colorTargetScopes
        : [];
    return requiredScopes.every((requiredRoots) =>
      colorGuidanceRoots.some((answerRoots) =>
        requiredRoots.some((root) => answerRoots.has(root)),
      ),
    );
  };
  const hasCatalogGuidance = Boolean(
    result?.product?.sku ||
      (Array.isArray(result?.estimates) &&
        result.estimates.some((estimate) => estimate?.candidateSku)),
  );
  const compoundRequestHasBudget =
    asks.length > 1 && asks.some(({ kind }) => kind === "budget");

  return asks
    .filter((ask) => {
      const { kind, scopeRoots } = ask;
      const answerScopeRoots = scopeRoots.filter(
        (root) => !askCoverageActionRoots.has(root),
      );
      // ponytail: a blocker answer selects the old ask's target; it is not a new task.
      if (!authoredCovers(ask) && !inheritsResolvedTargetAsk(ask)) return true;
      if (!hasVisibleAnswer) return true;
      if (kind === "color") return !hasColorGuidanceFor(answerScopeRoots);
      if (
        askColorRequestPattern.test(ask.request) &&
        !hasColorGuidanceFor(answerScopeRoots)
      ) return true;
      if (kind === "catalog") return !hasCatalogGuidance;
      if (askCatalogRequestPattern.test(ask.request) && !hasCatalogGuidance) return true;
      const resolvedDeicticTargetCovered =
        result?.resolvedIntent?.target?.state === "resolved" &&
        /(?:фото|photograph|photo|\bэто\b|\bthis\b)/iu.test(ask.request) &&
        [...resolvedTargetRoots].some((root) => visibleRoots.has(root));
      const scopeCovered =
        answerScopeRoots.length === 0 ||
        answerScopeRoots.some((root) => visibleRoots.has(root)) ||
        resolvedDeicticTargetCovered;
      if (!scopeCovered) return true;
      // ponytail: price one object in a compound paint request, price each named paint object.
      const requiresBudget =
        kind === "budget" ||
        (compoundRequestHasBudget &&
          kind === "general" &&
          ask.paintRequest &&
          !/(?:фото|photograph|photo|\bэто\b)/iu.test(ask.request));
      if (requiresBudget) {
        return !budgetMethodRoots.some(
          (methodRoots) =>
            answerScopeRoots.length === 0 ||
            answerScopeRoots.some((root) => methodRoots.has(root)),
        );
      }
      return false;
    })
    .map(({ request }) => request)
    .slice(0, 6);
}

// ponytail: keep the old export until recorded evaluators move to the generic name.
export const compoundReplyCoverageGaps = askCoverageGaps;

const humanTargetActionWordPattern =
  /^(?:покрас|перекрас|окрас|крас(?:и|ь|им|ят|ил)|нанес|примен|использ|обработ|хоч|меня|смен|paint|colour|color|coat|apply|use)/iu;

function explicitlyRequestsHumanTarget(value) {
  return normalizedEvidenceText(value)
    .split(/[.!?;,\n]+/u)
    .some((clause) => {
      const words = lexicalWords(clause);
      const humanIndex = words.findIndex((word) => isHumanTarget(word));
      if (
        humanIndex >= 0 &&
        words
          .slice(Math.max(0, humanIndex - 3), humanIndex)
          .some((word) => /^(?:объект|цел)/iu.test(word))
      ) {
        return true;
      }
      return words.some((word, actionIndex) => {
        if (!humanTargetActionWordPattern.test(word)) return false;
        const followingTarget = words
          .slice(actionIndex + 1, actionIndex + 5)
          .find((candidate) =>
            isHumanTarget(candidate) || isExplicitNonHumanTarget(candidate)
          );
        if (followingTarget) return isHumanTarget(followingTarget);
        const precedingTarget = words
          .slice(Math.max(0, actionIndex - 3), actionIndex)
          .reverse()
          .find((candidate) =>
            isHumanTarget(candidate) || isExplicitNonHumanTarget(candidate)
          );
        return Boolean(precedingTarget && isHumanTarget(precedingTarget));
      });
    });
}

function implicitDomainCandidates(candidates, job) {
  const customerText = latestCustomerText(job);
  if (
    !job?.visionObservation ||
    !customerText ||
    explicitlyRequestsHumanTarget(customerText)
  ) {
    return candidates;
  }
  return candidates.filter((candidate) =>
    !isHumanTarget(candidate.label)
  );
}

function candidateMentionIsNegated(candidate, message) {
  const normalizedCandidate = normalizedEvidenceText(candidate);
  const normalizedMessage = normalizedEvidenceText(message);
  if (!normalizedCandidate || !normalizedMessage) return false;
  const candidateWords = lexicalWords(normalizedCandidate);
  return candidateWords.some((candidateWord) =>
    [...normalizedMessage.matchAll(/[\p{L}\p{N}]{3,}/gu)].some((match) =>
      strongLexicalRootOverlap(candidateWord, match[0]) &&
      /(?:^|[^\p{L}])(?:не|not)(?:\s+[\p{L}]{2,16}){0,2}\s+$/iu.test(
        normalizedMessage.slice(0, match.index),
      ),
    ),
  );
}

const genericTargetDescriptorRoots = new Set([
  "внут",
  "нару",
  "объе",
  "поме",
  "пове",
  "част",
  "зада",
]);

function distinctVisionActionCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = lexicalRoots(candidate.label)
      .filter((root) => !genericTargetDescriptorRoots.has(root))
      .sort()
      .join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function significantVisionRoots(value) {
  return [
    ...new Set(
      lexicalRoots(value).filter((root) => !genericTargetDescriptorRoots.has(root)),
    ),
  ];
}

function visionCandidateSupport(candidate) {
  return [candidate?.label, candidate?.evidence]
    .map(cleanSemanticCopy)
    .filter(Boolean)
    .join(" ");
}

function visionRootsOverlap(left, right) {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function visionGroundingSections(storedVision) {
  return [
    storedVision?.summary,
    ...(storedVision?.visibleFacts ?? []),
    ...(storedVision?.scaleEvidence ?? []),
    ...(storedVision?.uncertainties ?? []),
  ].filter(Boolean);
}

function uniqueGroundedHumanActionCandidate(storedVision) {
  const visibleFacts = (storedVision?.visibleFacts ?? [])
    .map((fact) => cleanSemanticCopy(fact).slice(0, 160))
    .filter(Boolean)
    .map((fact) => ({ fact, roots: significantVisionRoots(fact) }));
  const candidates = new Map();
  for (const candidate of storedVision?.targetCandidates ?? []) {
    const labelRoots = [
      ...new Set(specificHumanActionRoots(candidate.label)),
    ];
    const supportRoots = [
      ...new Set(specificHumanActionRoots(visionCandidateSupport(candidate))),
    ];
    const roots = labelRoots.length ? labelRoots : supportRoots;
    const groundingFact = visibleFacts.find(({ fact, roots: factRoots }) =>
      neutralHumanContextWord(fact) &&
      roots.every((root) =>
        factRoots.some((factRoot) => visionRootsOverlap(root, factRoot)),
      ),
    );
    if (
      !roots.length ||
      containsUnsupportedPersonalInference(candidate.label, candidate.label) ||
      containsUnsupportedPersonalInference(
        groundingFact?.fact,
        candidate.label,
      ) ||
      !groundingFact
    ) {
      continue;
    }
    const candidateLabel = cleanSemanticCopy(candidate.label).slice(0, 160);
    const hasNeutralContext = lexicalWords(candidateLabel).some((word) =>
      lexicalRoots(word).some((root) => neutralHumanContextRoots.has(root)),
    );
    const groundedSupportLabel = cleanSemanticCopy(candidate.evidence)
      .slice(0, 160);
    const groundedLabel = labelRoots.length === 0 && supportRoots.length > 0
      ? groundedSupportLabel || groundingFact.fact
      : hasNeutralContext
        ? candidateLabel
      : cleanSemanticCopy(
          `${candidateLabel} ${neutralHumanContextWord(groundingFact.fact)}`,
        ).slice(0, 160);
    if (groundedLabel) {
      candidates.set(roots.slice().sort().join(" "), {
        ...candidate,
        label: groundedLabel,
      });
    }
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

function uniqueUnlistedVisibleHumanActionCandidate(storedVision) {
  const listedRoots = (storedVision?.targetCandidates ?? []).flatMap((candidate) =>
    specificHumanActionRoots(visionCandidateSupport(candidate))
  );
  const candidates = new Map();
  for (const visibleFact of storedVision?.visibleFacts ?? []) {
    const fact = cleanSemanticCopy(visibleFact).slice(0, 160);
    const contextWord = neutralHumanContextWord(fact);
    const roots = [...new Set(specificHumanActionRoots(fact))];
    if (
      !fact ||
      !contextWord ||
      roots.length !== 1 ||
      containsUnsupportedPersonalInference(fact, fact) ||
      listedRoots.some((root) => visionRootsOverlap(root, roots[0]))
    ) {
      continue;
    }
    const actionWord = lexicalWords(fact).find((word) =>
      specificHumanActionRoots(word).some((root) =>
        visionRootsOverlap(root, roots[0])
      )
    );
    if (actionWord) candidates.set(roots[0], { label: fact, confidence: 0.5 });
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

// ponytail: preserve a supported human category; ungrounded detail falls back to neutral generic wording.
function groundedHumanPrimaryLabel(primary, storedVision) {
  const label = cleanSemanticCopy(primary?.label).slice(0, 160);
  if (!label || !isHumanTarget(label)) return null;
  const labelRoots = significantVisionRoots(label);
  const sectionRoots = visionGroundingSections(storedVision).flatMap(
    significantVisionRoots,
  );
  const supportedRoots = labelRoots.filter((root) =>
    sectionRoots.some((sectionRoot) => visionRootsOverlap(root, sectionRoot)),
  );
  const humanRoots = lexicalWords(label)
    .filter((word) => isHumanTarget(word))
    .map((word) => word.slice(0, Math.min(4, word.length)));
  if (
    !humanRoots.some((root) =>
      sectionRoots.some((sectionRoot) => visionRootsOverlap(root, sectionRoot)),
    )
  ) {
    return null;
  }
  return supportedRoots.length === labelRoots.length ? label : "Человек";
}

function groundedVisionCandidateLabel(candidate, primaryCandidates, storedVision) {
  const label = cleanSemanticCopy(candidate?.label).slice(0, 160);
  const support = cleanSemanticCopy(candidate?.evidence)
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/u, "")
    .slice(0, 100)
    .trim();
  const labelRoots = significantVisionRoots(label);
  if (labelRoots.length === 1 && isHumanTarget(label)) {
    const supportedRoots = significantVisionRoots(
      [
        storedVision?.summary,
        ...(storedVision?.visibleFacts ?? []),
        candidate?.evidence,
      ]
        .filter(Boolean)
        .join(" "),
    );
    const supportedPrimaryCandidates = primaryCandidates.filter((primary) => {
      const primaryLabel = cleanSemanticCopy(primary?.label).slice(0, 160);
      const primaryRoots = significantVisionRoots(primaryLabel);
      const concreteRoots = primaryRoots.filter(
        (root) => !labelRoots.some((genericRoot) => visionRootsOverlap(root, genericRoot)),
      );
      return (
        primaryLabel &&
        primary.evidenceIds?.length &&
        isHumanTarget(primaryLabel) &&
        !containsUnsupportedPersonalInference(primaryLabel, label) &&
        labelRoots.every((root) =>
          primaryRoots.some((candidateRoot) => visionRootsOverlap(root, candidateRoot)),
        ) &&
        concreteRoots.length > 0 &&
        concreteRoots.every((root) =>
          supportedRoots.some((supportedRoot) => visionRootsOverlap(root, supportedRoot)),
        )
      );
    });
    if (supportedPrimaryCandidates.length === 1) {
      const primary = supportedPrimaryCandidates[0];
      const primaryRoots = significantVisionRoots(primary.label);
      const concretePrimaryRoots = primaryRoots.filter(
        (root) => !labelRoots.some((genericRoot) => visionRootsOverlap(root, genericRoot)),
      );
      const safeVisibleFacts = (storedVision?.visibleFacts ?? [])
        .map((fact) => cleanSemanticCopy(fact).slice(0, 160))
        .filter(
          (fact) =>
            fact && !containsUnsupportedPersonalInference(fact, label),
        );
      const scoredVisibleFacts = safeVisibleFacts
        .map((fact) => ({
          fact,
          score: concretePrimaryRoots.filter((root) =>
            significantVisionRoots(fact).some((factRoot) =>
              visionRootsOverlap(root, factRoot),
            ),
          ).length,
        }))
        .filter(({ score }) => score > 0);
      const highestScore = Math.max(
        0,
        ...scoredVisibleFacts.map(({ score }) => score),
      );
      const highestFacts = scoredVisibleFacts.filter(
        ({ score }) => score === highestScore,
      );
      if (highestScore > 0 && highestFacts.length === 1) {
        return highestFacts[0].fact;
      }
      return label;
    }
    return label;
  }
  const hasGroundedDetailedParaphrase = primaryCandidates.some((primary) => {
    const primaryRoots = significantVisionRoots(primary?.label);
    if (primaryRoots.length <= labelRoots.length ||
        !labelRoots.every((root) => primaryRoots.includes(root))) {
      return false;
    }
    const visibleEvidenceItems = [
      storedVision?.summary,
      ...(storedVision?.visibleFacts ?? []),
    ];
    return visibleEvidenceItems.some((item) => {
      const itemRoots = new Set(significantVisionRoots(item));
      return primaryRoots.every((root) => itemRoots.has(root));
    });
  });
  return labelRoots.length === 1 && hasGroundedDetailedParaphrase && support
    ? `${label} (${support})`.slice(0, 160)
    : label;
}

function projectVisionCandidateLabels(primaryCandidates, storedCandidates) {
  const possibleMatches = primaryCandidates.map((primary) => {
    const primaryRoots = significantVisionRoots(primary.label);
    if (!primaryRoots.length) return [];
    return storedCandidates
      .map((stored, index) => {
        const supportRoots = new Set(
          significantVisionRoots(visionCandidateSupport(stored)),
        );
        const storedLabelRoots = significantVisionRoots(stored.label);
        const storedLabelRootCount = storedLabelRoots.length;
        return primaryRoots.every((root) => supportRoots.has(root)) &&
          primaryRoots.length > storedLabelRootCount &&
          !(storedLabelRootCount === 1 &&
            isHumanTarget(stored.label) &&
            isHumanTarget(primary.label))
          ? index
          : null;
      })
      .filter((index) => index !== null);
  });
  const matchedPrimaryCountByStored = storedCandidates.map(
    (_, storedIndex) =>
      possibleMatches.filter((matches) => matches.includes(storedIndex)).length,
  );
  return storedCandidates.map((stored, storedIndex) => {
    const primaryIndex = possibleMatches.findIndex(
      (matches) =>
        matches.length === 1 &&
        matches[0] === storedIndex &&
        matchedPrimaryCountByStored[storedIndex] === 1,
    );
    return primaryIndex >= 0
      ? { ...stored, label: primaryCandidates[primaryIndex].label }
      : stored;
  }).filter((stored, storedIndex) => {
    const supportRoots = significantVisionRoots(
      visionCandidateSupport(storedCandidates[storedIndex]),
    );
    return primaryCandidates.some((primary) => {
      const primaryRoots = significantVisionRoots(primary.label);
      return primaryRoots.length > 0 && primaryRoots.every((root) =>
        supportRoots.some((supportRoot) =>
          visionRootsOverlap(root, supportRoot),
        ),
      );
    });
  }).slice(0, primaryCandidates.length);
}

function appendSupportedPrimaryVisionCandidates(
  primaryCandidates,
  storedCandidates,
  storedVision,
  trustedVisionEvidenceIds,
) {
  const storedSupports = storedCandidates.map((stored) =>
    new Set(significantVisionRoots(visionCandidateSupport(stored))),
  );
  const supportItems = [storedVision?.summary, ...(storedVision?.visibleFacts ?? [])]
    .filter(Boolean)
    .map((item) => new Set(significantVisionRoots(item)));
  const seen = new Set(
    storedCandidates.map((candidate) =>
      significantVisionRoots(candidate.label)
        .sort()
        .join(" "),
    ),
  );
  const storedHasHumanCandidate = storedCandidates.some((candidate) =>
    isHumanTarget(candidate.label),
  );
  const genericStoredRoots = new Set(
    storedCandidates.flatMap((stored) => {
      const labelRoots = significantVisionRoots(
        stored.label.replace(/\s*\([^)]*\)\s*$/u, ""),
      );
      return lexicalRoots(
        stored.label.replace(/\s*\([^)]*\)\s*$/u, ""),
      ).length === 1
        ? labelRoots
        : [];
    }),
  );
  return primaryCandidates.flatMap((primary) => {
    const originalLabel = cleanSemanticCopy(primary?.label).slice(0, 160);
    const humanLabel = groundedHumanPrimaryLabel(primary, storedVision);
    if (
      !originalLabel ||
      (isHumanTarget(originalLabel) &&
        (!humanLabel || storedHasHumanCandidate))
    ) {
      return [];
    }
    const label = humanLabel || originalLabel;
    const roots = significantVisionRoots(label);
    const originalRoots = significantVisionRoots(originalLabel);
    const key = roots.slice().sort().join(" ");
    if (
      !roots.length ||
      !primary.evidenceIds?.some((id) => trustedVisionEvidenceIds.includes(id)) ||
      seen.has(key) ||
      roots.some((root) => genericStoredRoots.has(root)) ||
      storedSupports.some((support) => roots.every((root) => support.has(root)))
    ) {
      return [];
    }
    if (!humanLabel &&
        !supportItems.some((support) =>
          originalRoots.every((root) => support.has(root)),
        )) {
      return [];
    }
    seen.add(key);
    return [{ ...primary, label }];
  });
}

function normalizeResolvedIntent(value, job, demoData) {
  const intent = objectRecord(value);
  if (!intent) return null;
  const authoredGoal = cleanSemanticCopy(intent.goal).slice(0, 320);
  const target = objectRecord(intent.target);
  const evidence = normalizeEvidence(
    intent.evidence,
    job,
    demoData,
    target?.label,
  );
  if (evidence.length && !evidence.some((item) => item.source.kind === "web")) {
    const toolEvidence = neutralOpenedEvidence(
      job,
      new Set(evidence.map((item) => item.id)),
    );
    if (toolEvidence) evidence.push(toolEvidence);
  }
  const allowLegacyAsks = job?.requireResolvedAsks !== true;
  const latestMessageRound = [...messageTextsByRound(job).entries()]
    .sort(([left], [right]) => right - left)[0];
  if (
    allowLegacyAsks &&
    latestMessageRound &&
    !evidence.some((item) => item.source.kind === "message")
  ) {
    const existingIds = new Set(evidence.map((item) => item.id));
    let id = "legacy-request-evidence";
    let suffix = 1;
    while (existingIds.has(id)) {
      suffix += 1;
      id = `legacy-request-evidence-${suffix}`;
    }
    evidence.push({
      id,
      claim: "Последнее сообщение клиента сохранено для совместимости результата",
      confidence: 1,
      source: {
        kind: "message",
        roundNo: latestMessageRound[0],
        quote: latestMessageRound[1].join(" ").slice(0, 420),
      },
    });
  }
  const evidenceIds = new Set(
    evidence
      .filter((item) => !isNeutralOpenedEvidence(item))
      .map((item) => item.id),
  );
  const asks = normalizeResolvedAsks(intent.asks, evidence, {
    allowLegacy: allowLegacyAsks,
    legacyRequest: latestCustomerText(job),
    intent,
  });
  const targetEvidenceIds = new Set(
    evidence
      .filter((item) => ["message", "vision"].includes(item.source.kind))
      .map((item) => item.id),
  );
  const suppressUnsupportedAttribution =
    !evidence.some(
      (item) => item.source.kind === "web" && !isNeutralOpenedEvidence(item),
    ) && draftHasUnsupportedNamedAttribution(
      { resolvedIntent: intent },
      job,
      demoData,
    );
  const targetLabel = cleanSemanticCopy(target?.label).slice(0, 160);
  const goal = suppressUnsupportedAttribution
    ? `Подготовить решение для «${targetLabel || "объекта из запроса"}»`
    : authoredGoal;
  const assumptions = normalizeAssumptions(intent.assumptions, evidenceIds).map(
    (assumption) => suppressUnsupportedAttribution
      ? {
          ...assumption,
          claim: `Рабочее допущение для диапазонной оценки; проверить перед этапом ${assumption.confirmBefore}.`,
        }
      : assumption,
  );
  if (
    !goal ||
    !asks ||
    containsUnsupportedPersonalInference(goal, target?.label) ||
    !target ||
    evidence.length === 0
  ) {
    return null;
  }

  if (
    target.state === "ambiguous" &&
    (containsPersonalInference(intent.blocker?.question) ||
      (Array.isArray(intent.blocker?.choices) &&
        intent.blocker.choices.some((choice) => containsPersonalInference(choice))))
  ) {
    return null;
  }

  if (target.state === "resolved") {
    const label = targetLabel;
    const resolvedTargetEvidenceIds = validReferencedIds(
      target.evidenceIds,
      targetEvidenceIds,
      { allowSubset: true },
    );
    const customerText = latestCustomerText(job);
    if (
      label &&
      isHumanTarget(label) &&
      customerText &&
      !explicitlyRequestsHumanTarget(customerText)
    ) {
      const storedVision = normalizeVisionObservation(job?.visionObservation);
      const trustedVisionEvidenceIds = evidence
        .filter((item) => item.source?.kind === "vision")
        .map((item) => item.id);
      const inanimateCandidates =
        storedVision &&
        ["relevant", "uncertain"].includes(storedVision.relevance) &&
        trustedVisionEvidenceIds.length
          ? canonicalTargetCandidates(
              implicitDomainCandidates(
                storedVision.targetCandidates.map((candidate) => ({
                  label: candidate.label,
                  confidence: candidate.confidence,
                  evidenceIds: trustedVisionEvidenceIds,
                })),
                job,
              ),
            )
          : [];
      if (inanimateCandidates.length === 1) {
        const [candidate] = inanimateCandidates;
        return {
          goal: `Подготовить решение для «${candidate.label}»`,
          asks,
          target: {
            state: "resolved",
            label: candidate.label,
            evidenceIds: candidate.evidenceIds,
          },
          evidence,
          assumptions,
          blocker: null,
        };
      }
      if (inanimateCandidates.length >= 2) {
        const choices = inanimateCandidates.map((candidate) => candidate.label);
        return {
          goal: "Определить неодушевлённый объект действия",
          asks,
          target: { state: "ambiguous", candidates: inanimateCandidates },
          evidence,
          assumptions,
          blocker: {
            kind: "target_ambiguity",
            question: canonicalTargetQuestion(choices),
            choices,
          },
        };
      }
      return null;
    }
    if (
      label &&
      resolvedTargetEvidenceIds &&
      customerText &&
      isExplicitNonHumanTarget(label) &&
      !targetGroundedByMessage(label, customerText)
    ) {
      const storedVision = normalizeVisionObservation(job?.visionObservation);
      const trustedVisionEvidenceIds = evidence
        .filter((item) => item.source?.kind === "vision")
        .map((item) => item.id);
      const labelRoots = significantVisionRoots(label);
      const groundedTarget = storedVision?.targetCandidates.find((candidate) => {
        const candidateRoots = significantVisionRoots(candidate.label);
        return labelRoots.length && labelRoots.every((root) =>
          candidateRoots.some((candidateRoot) =>
            visionRootsOverlap(root, candidateRoot)
          )
        );
      });
      const humanCandidate = explicitlyRequestsHumanTarget(customerText)
        ? uniqueUnlistedVisibleHumanActionCandidate(storedVision)
        : null;
      if (
        storedVision &&
        ["relevant", "uncertain"].includes(storedVision.relevance) &&
        trustedVisionEvidenceIds.length &&
        resolvedTargetEvidenceIds.some((id) => trustedVisionEvidenceIds.includes(id)) &&
        groundedTarget &&
        humanCandidate
      ) {
        // ponytail: explicit human text wins; vision-only human context never does.
        return {
          goal: `Подготовить безопасный ответ для «${humanCandidate.label}»`,
          asks,
          target: {
            state: "resolved",
            label: humanCandidate.label,
            evidenceIds: trustedVisionEvidenceIds,
          },
          evidence,
          assumptions,
          blocker: null,
        };
      }
    }
    if (label && candidateMentionIsNegated(label, latestCustomerText(job))) {
      const storedVision = normalizeVisionObservation(job?.visionObservation);
      const trustedVisionEvidenceIds = evidence
        .filter((item) => item.source?.kind === "vision")
        .map((item) => item.id);
      const storedCandidates =
        storedVision &&
        ["relevant", "uncertain"].includes(storedVision.relevance) &&
        storedVision.targetCandidates.length >= 2 &&
        trustedVisionEvidenceIds.length
          ? distinctVisionActionCandidates(
              storedVision.targetCandidates.map((candidate) => ({
                label: candidate.label,
                confidence: candidate.confidence,
                evidenceIds: trustedVisionEvidenceIds,
              })),
            ).map(({ label: candidateLabel, confidence: candidateConfidence, evidenceIds }) => ({
              label: candidateLabel,
              confidence: candidateConfidence,
              evidenceIds,
            }))
          : [];
      if (storedCandidates.length >= 2) {
        const candidates = canonicalTargetCandidates(storedCandidates.slice(0, 6));
        const choices = candidates.map((candidate) => candidate.label);
        return {
          goal,
          asks,
          target: {
            state: "ambiguous",
            candidates,
          },
          evidence,
          assumptions,
          blocker: {
            kind: "target_ambiguity",
            question: canonicalTargetQuestion(choices),
            choices,
          },
        };
      }
      return null;
    }
    return label &&
      !containsUnsupportedPersonalInference(label, label) &&
      resolvedTargetEvidenceIds
      ? {
          goal,
          asks,
          target: {
            state: "resolved",
            label,
            evidenceIds: resolvedTargetEvidenceIds,
          },
          evidence,
          assumptions,
          blocker: null,
        }
      : null;
  }

  if (target.state !== "ambiguous" || !Array.isArray(target.candidates)) {
    return null;
  }
  let candidates = target.candidates
    .map((item) => {
      const label = cleanSemanticCopy(item?.label).slice(0, 160);
      const candidateConfidence = confidence(item?.confidence);
      const candidateEvidenceIds = validReferencedIds(
        item?.evidenceIds,
        targetEvidenceIds,
        { allowSubset: true },
      );
      return label &&
        !containsUnsupportedPersonalInference(label, label) &&
        candidateConfidence !== null &&
        candidateEvidenceIds
        ? {
            label,
            confidence: candidateConfidence,
            evidenceIds: candidateEvidenceIds,
          }
        : null;
    })
    .filter(Boolean)
    .slice(0, 6);
  if (!candidates.length || intent.blocker?.kind !== "target_ambiguity") {
    return null;
  }

  const storedVision = normalizeVisionObservation(job?.visionObservation);
  let primaryCandidates = candidates;
  const trustedVisionEvidenceIds = evidence
    .filter((item) => item.source?.kind === "vision")
    .map((item) => item.id);
  const deduplicatedStoredCandidates =
    storedVision &&
    ["relevant", "uncertain"].includes(storedVision.relevance) &&
    storedVision.targetCandidates.length >= 2 &&
    trustedVisionEvidenceIds.length
      ? distinctVisionActionCandidates(
          storedVision.targetCandidates.map((candidate) => ({
            label: candidate.label,
            confidence: candidate.confidence,
            evidence: candidate.evidence,
            evidenceIds: trustedVisionEvidenceIds,
          })),
        ).map((candidate) => ({
          ...candidate,
          label: groundedVisionCandidateLabel(
            candidate,
            primaryCandidates,
            storedVision,
          ),
        }))
      : null;
  const storedCandidates = deduplicatedStoredCandidates?.map(
    ({ label, confidence, evidence, evidenceIds }) => ({
      label,
      confidence,
      evidence,
      evidenceIds,
    }),
  );
  if (storedCandidates?.length >= 2) {
    let refinedHumanCandidate = null;
    const genericHumanCandidates = primaryCandidates.filter(
      (candidate) =>
        isHumanTarget(candidate.label) &&
        specificHumanActionRoots(candidate.label).length === 0,
    );
    const specificHumanCandidate = uniqueGroundedHumanActionCandidate(
      storedVision,
    );
    if (genericHumanCandidates.length === 1 && specificHumanCandidate) {
      refinedHumanCandidate = specificHumanCandidate;
      primaryCandidates = primaryCandidates.map((candidate) =>
        candidate === genericHumanCandidates[0]
          ? { ...candidate, label: specificHumanCandidate.label }
          : candidate,
      );
    }
    candidates = projectVisionCandidateLabels(
      primaryCandidates,
      deduplicatedStoredCandidates,
    ).map(({ label, confidence, evidenceIds }) => ({
      label,
      confidence,
      evidenceIds,
    }));
    candidates.push(
      ...appendSupportedPrimaryVisionCandidates(
        primaryCandidates,
        storedCandidates,
        storedVision,
        trustedVisionEvidenceIds,
      ).map(({ label, confidence, evidenceIds }) => ({
        label,
        confidence,
        evidenceIds,
      })),
    );
    if (candidates.length < 2) {
      const labels = new Set(candidates.map((candidate) => candidate.label));
      candidates.push(
        ...storedCandidates.filter(({ label }) => !labels.has(label))
          .slice(0, 2 - candidates.length)
          .map(({ label, confidence, evidenceIds }) => ({
            label,
            confidence,
            evidenceIds,
          })),
      );
      const storedOrder = new Map(
        storedCandidates.map(({ label }, index) => [label, index]),
      );
      candidates.sort(
        (left, right) =>
          (storedOrder.get(left.label) ?? Number.MAX_SAFE_INTEGER) -
          (storedOrder.get(right.label) ?? Number.MAX_SAFE_INTEGER),
      );
    }
    if (refinedHumanCandidate) {
      const refinedRoots = specificHumanActionRoots(
        refinedHumanCandidate.label,
      ).slice().sort().join(" ");
      candidates = candidates.map((candidate) => {
        const candidateHumanRoots = specificHumanActionRoots(candidate.label)
          .slice().sort().join(" ");
        return isHumanTarget(candidate.label) &&
            (!candidateHumanRoots || candidateHumanRoots === refinedRoots)
          ? { ...candidate, label: refinedHumanCandidate.label }
          : candidate;
      });
    }
    candidates = candidates.slice(0, 6);
  }
  const customerText = latestCustomerText(job);
  if (customerText && explicitlyRequestsHumanTarget(customerText)) {
    const humanCandidates = candidates.filter((candidate) =>
      isHumanTarget(candidate.label)
    );
    const groundedHumanCandidates = humanCandidates.filter((candidate) =>
      targetGroundedByMessage(candidate.label, customerText)
    );
    if (groundedHumanCandidates.length === 1) {
      candidates = groundedHumanCandidates;
    } else if (humanCandidates.length === 1) {
      candidates = humanCandidates;
    }
  } else {
    const primaryInanimateCandidates = implicitDomainCandidates(
      primaryCandidates,
      job,
    );
    candidates = implicitDomainCandidates(candidates, job);
    if (
      candidates.length < 2 &&
      primaryInanimateCandidates.length >= 2 &&
      storedCandidates
    ) {
      const storedInanimateCandidates = implicitDomainCandidates(
        storedCandidates,
        job,
      );
      if (storedInanimateCandidates.length >= 2) {
        candidates = storedInanimateCandidates;
      }
    }
  }
  candidates = canonicalTargetCandidates(candidates);
  if (candidates.length === 1) {
    const [candidate] = candidates;
    return {
      goal: `Подготовить решение для «${candidate.label}»`,
      asks,
      target: {
        state: "resolved",
        label: candidate.label,
        evidenceIds: candidate.evidenceIds,
      },
      evidence,
      assumptions,
      blocker: null,
    };
  }
  if (candidates.length < 2) return null;
  const choices = candidates.map((candidate) => candidate.label);

  return {
    goal,
    asks,
    target: { state: "ambiguous", candidates },
    evidence,
    assumptions,
    blocker: {
      kind: "target_ambiguity",
      question: canonicalTargetQuestion(choices),
      choices,
    },
  };
}

function productSupportsIntent(product, intent) {
  if (!product || !intent || intent.target.state !== "resolved") return false;
  const targetLabel = normalizedEvidenceText(intent.target.label);
  const productIdentity = [product.sku, product.name, product.category]
    .map(normalizedEvidenceText)
    .filter(Boolean);
  // A bare SKU is a procurement target; a SKU embedded in an application
  // target is not evidence that the requested object accepts the product.
  if (productIdentity.includes(targetLabel)) return true;
  if (!Array.isArray(product.substrates)) return false;
  if (productIdentity.some((identity) => targetLabel.includes(identity))) {
    return false;
  }
  const genericTargetRoots = new Set([
    "внут",
    "зона",
    "конс",
    "нару",
    "объе",
    "пове",
    "учас",
    "част",
    "крас",
    "покр",
    "цвет",
    "surf",
  ]);
  const targetRoots = lexicalRoots(intent.target.label).filter(
    (root) => !genericTargetRoots.has(root),
  );
  const catalogRoots = new Set(
    lexicalRoots(
      [
        product.sku,
        product.name,
        product.category,
        ...product.substrates,
      ].join(" "),
    ),
  );
  if (!targetRoots.length || !catalogRoots.size) return false;
  // ponytail: every meaningful target root must be catalog-grounded; a
  // substrate mentioned elsewhere cannot fill an unknown application root.
  return targetRoots.every((root) => catalogRoots.has(root));
}

function trustedTargetEvidenceSupportsProduct(product, intent) {
  if (!isExplicitNonHumanTarget(intent?.target?.label)) return false;
  const targetEvidenceIds = new Set(intent.target.evidenceIds ?? []);
  const trustedText = intent.evidence
    .filter((item) => targetEvidenceIds.has(item.id))
    .map((item) =>
      item.source?.kind === "message"
        ? item.source.quote
        : item.source?.kind === "vision"
          ? item.source.observation
          : "",
    )
    .join(" ");
  const trustedRoots = new Set(lexicalRoots(trustedText));
  return (product?.substrates ?? []).some((substrate) =>
    lexicalRoots(substrate).some((root) => trustedRoots.has(root)),
  );
}

function normalizeEstimates(
  value,
  intent,
  demoData,
  { enforceCatalogCompatibility = true } = {},
) {
  if (!Array.isArray(value) || !intent) return [];
  const products = Array.isArray(demoData?.products) ? demoData.products : [];
  const evidenceIds = new Set(
    intent.evidence
      .filter((item) => !isNeutralOpenedEvidence(item))
      .map((item) => item.id),
  );
  const targetEvidenceIds = new Set(intent.target?.evidenceIds ?? []);
  const hasTargetVisionEvidence = intent.evidence.some(
    (item) =>
      targetEvidenceIds.has(item.id) && item.source?.kind === "vision",
  );
  const assumptionIds = new Set(intent.assumptions.map((item) => item.id));
  const animateContext = isHumanTarget(intent.target.label);
  const estimates = value
    .map((item) => {
      const metric = ["surface_area", "paint_quantity", "budget"].includes(
        item?.metric,
      )
        ? item.metric
        : "";
      const range = normalizeRange(item?.range);
      const method = cleanSemanticCopy(item?.method).slice(0, 420);
      const candidateSku = cleanSourceText(item?.candidateSku, 40).toUpperCase();
      const candidateProduct = candidateSku
        ? products.find((product) => product.sku === candidateSku)
        : null;
      const targetRoots = new Set(lexicalRoots(intent.target.label));
      const candidateSkuGrounded = Boolean(
        candidateProduct &&
          (productSupportsIntent(candidateProduct, intent) ||
            (isExplicitNonHumanTarget(intent.target.label) &&
              candidateProduct.substrates?.some((substrate) =>
                lexicalRoots(substrate).some((root) => targetRoots.has(root)),
              ))),
      );
      const rawAssumptionIds =
        item?.assumptionIds === undefined ? [] : item.assumptionIds;
      const compatibilityNeedsVerification = Boolean(
        enforceCatalogCompatibility &&
          candidateProduct &&
          candidateSku &&
          !candidateSkuGrounded &&
          !animateContext,
      );
      const estimateEvidenceIds = validReferencedIds(
        item?.evidenceIds,
        evidenceIds,
      );
      const estimateAssumptionIds = validReferencedIds(
        rawAssumptionIds,
        assumptionIds,
        {
          allowEmpty: Array.isArray(rawAssumptionIds) &&
            rawAssumptionIds.length === 0,
          // ponytail: an unverified known SKU may invalidate only its
          // compatibility assumption; retain grounded range dependencies.
          allowSubset: compatibilityNeedsVerification,
        },
      );
      const estimateConfidence = confidence(item?.confidence);
      const catalogSupportsIntent = products.some((product) =>
        productSupportsIntent(product, intent),
      );
      const groundedSku =
        !enforceCatalogCompatibility ||
        (candidateSku
          ? candidateSkuGrounded ||
            isExplicitNonHumanTarget(intent.target.label) ||
            hasTargetVisionEvidence
          : metric !== "paint_quantity" ||
            catalogSupportsIntent ||
            isExplicitNonHumanTarget(intent.target.label) ||
            hasTargetVisionEvidence);
      const estimateAccepted = groundedSku && !animateContext;
      const normalizedUnit = normalizedEvidenceText(range?.unit).replace(
        /\s+/gu,
        "",
      );
      const expectedUnit =
        metric === "surface_area"
          ? ["м²", "м2", "m²", "m2"].includes(normalizedUnit)
          : metric === "paint_quantity"
            ? ["кг", "kg"].includes(normalizedUnit)
            : metric === "budget"
              ? ["₽", "руб", "руб."].includes(normalizedUnit)
              : false;
      return metric &&
        range &&
        expectedUnit &&
        method &&
        estimateEvidenceIds &&
        estimateAssumptionIds &&
        estimateConfidence !== null &&
        estimateAccepted
        ? {
            metric,
            range,
            method,
            evidenceIds: estimateEvidenceIds,
            assumptionIds: estimateAssumptionIds,
            confidence: estimateConfidence,
            ...(candidateSkuGrounded ? { candidateSku } : {}),
          }
        : null;
    })
    .filter(Boolean)
    .slice(0, 6);
  const targetRoots = new Set(lexicalRoots(intent.target.label));
  const messageText = intent.evidence
    .filter((evidence) => evidence.source?.kind === "message")
    .map((evidence) => evidence.source.quote)
    .join(" ");
  const messageRoots = new Set(lexicalRoots(messageText));
  const targetNamedInMessage = [...targetRoots].some((root) =>
    messageRoots.has(root),
  );
  const requestsCatalogGuidance =
    /(?:како\p{L}*\s+цвет|цвет\p{L}*[^.!?]{0,60}(?:выбр|лучш|посовет|рекоменд)|каку\p{L}*\s+краск|краск\p{L}*[^.!?]{0,60}(?:выбр|посовет|рекоменд)|каталог|палитр|recommend[^.!?]{0,40}(?:paint|colou?r))/iu.test(
      messageText,
    );
  if (
    enforceCatalogCompatibility &&
    intent.target?.state === "resolved" &&
    !intent.blocker &&
    targetNamedInMessage &&
    requestsCatalogGuidance &&
    !animateContext &&
    !estimates.some((estimate) => estimate.candidateSku)
  ) {
    const compatibleProducts = products.filter(
      (product) =>
        productSupportsIntent(product, intent) ||
        product.substrates?.some((substrate) =>
          lexicalRoots(substrate).some((root) => targetRoots.has(root)),
        ),
    );
    if (compatibleProducts.length === 1) {
      const paintEstimate =
        estimates.find(
          (estimate) =>
            estimate.metric === "paint_quantity" &&
            lexicalRoots(estimate.method).some((root) => targetRoots.has(root)),
        ) ?? estimates.find((estimate) => estimate.metric === "paint_quantity");
      if (paintEstimate) paintEstimate.candidateSku = compatibleProducts[0].sku;
    }
  }
  const area = estimates.find((item) => item.metric === "surface_area");
  const paint = estimates.find((item) => item.metric === "paint_quantity");
  if (area && paint && paint.range.max > area.range.max * 5) {
    return estimates.filter((item) => item !== paint);
  }
  return estimates;
}

function canonicalFencePlanningEstimates(estimates, intent, demoData, job) {
  const request = latestCustomerText(job);
  if (
    intent?.target?.state !== "resolved" ||
    !/забор/iu.test(`${intent.target.label} ${request}`) ||
    !/дерев/iu.test(`${intent.target.label} ${request}`) ||
    /(?:\d[\d\s.,]*\s*(?:м²|м2|кв\.?\s*м|метр\p{L}*|см)|(?:длин|высот)\p{L}*[^.!?\n]{0,30}\d)/iu.test(
      request,
    )
  ) {
    return estimates;
  }
  const product = demoData?.products?.find(
    (item) =>
      item.sku === "КР-005" &&
      Number(item.coverageKgPerM2PerCoat) > 0 &&
      Number(item.recommendedCoats) > 0 &&
      Number(item.packKg) > 0 &&
      Number(item.pricePerKg) > 0,
  );
  if (!product) return estimates;

  const evidenceIds = intent.target.evidenceIds?.length
    ? intent.target.evidenceIds.slice(0, 4)
    : intent.evidence
        .filter((item) => item.source?.kind === "message")
        .map((item) => item.id)
        .slice(0, 1);
  if (!evidenceIds.length) return estimates;
  let assumption = intent.assumptions.find(
    (item) =>
      /забор/iu.test(item.claim) &&
      (/(?:площад|размер|диапаз)/iu.test(item.claim) ||
        ["м²", "м2", "m²", "m2"].includes(
          normalizedEvidenceText(item.range?.unit).replace(/\s+/gu, ""),
        )),
  );
  if (!assumption) {
    let id = "fence-planning-range";
    for (let suffix = 2; intent.assumptions.some((item) => item.id === id); suffix += 1) {
      id = `fence-planning-range-${suffix}`;
    }
    assumption = {
      id,
      claim:
        "До получения размеров деревянного забора используем плановый диапазон площади 20–60 м².",
      basedOnEvidenceIds: evidenceIds,
      confidence: 0.35,
      range: { min: 20, max: 60, unit: "м²" },
      confirmBefore: "commercial_offer",
    };
    intent.assumptions.push(assumption);
  } else {
    Object.assign(assumption, {
      claim:
        "До получения размеров деревянного забора используем плановый диапазон площади 20–60 м².",
      basedOnEvidenceIds: evidenceIds,
      confidence: 0.35,
      range: { min: 20, max: 60, unit: "м²" },
      confirmBefore: "commercial_offer",
    });
  }

  const paintMin = Math.round(
    20 *
      product.coverageKgPerM2PerCoat *
      product.recommendedCoats *
      1.1,
  );
  const paintMax = Math.ceil(
    60 *
      product.coverageKgPerM2PerCoat *
      product.recommendedCoats *
      1.1,
  );
  const budgetMin =
    Math.ceil(paintMin / product.packKg) *
    product.packKg *
    product.pricePerKg;
  const budgetMax =
    Math.ceil(paintMax / product.packKg) *
    product.packKg *
    product.pricePerKg;
  const priorByMetric = new Map(
    estimates
      .filter((item) => /забор/iu.test(item.method))
      .map((item) => [item.metric, item]),
  );
  const estimate = (metric, range, method) => ({
    metric,
    range,
    method,
    evidenceIds,
    assumptionIds: [assumption.id],
    confidence: priorByMetric.get(metric)?.confidence ?? 0.4,
    candidateSku: product.sku,
  });
  const fenceEstimates = [
    estimate(
      "surface_area",
      { min: 20, max: 60, unit: "м²" },
      "Дачный забор: плановый диапазон площади до получения размеров",
    ),
    estimate(
      "paint_quantity",
      { min: paintMin, max: paintMax, unit: "кг" },
      "Дачный забор: площадь × расход каталога × два слоя с 10% запаса",
    ),
    estimate(
      "budget",
      { min: budgetMin, max: budgetMax, unit: "₽" },
      "Дачный забор: расход округлён до целых упаковок × цена каталога",
    ),
  ];
  return [
    ...fenceEstimates,
    ...estimates.filter((item) => !/забор/iu.test(item.method)),
  ].slice(0, 6);
}

function normalizeSupplierLeads(value, job) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const supplier = cleanSemanticCopy(item?.supplier).slice(0, 160);
      const url = canonicalPublicHttpsUrl(item?.url);
      const openedAt = cleanSourceText(item?.openedAt, 80);
      const record = sourceRecordFor({ url }, job);
      const rawObservedClaims = Array.isArray(item?.observedClaims)
        ? item.observedClaims
        : [];
      const commercialKinds = [
        ...new Set(rawObservedClaims.flatMap(supplierCommercialKinds)),
      ];
      const observedClaims = rawObservedClaims
        .flatMap(supplierObservationClauses)
        .map(safeSupplierClause)
        .filter(
          (claim) =>
            claim &&
            claim !== openedEvidenceClaim &&
            supplierCommercialKinds(claim).length === 0 &&
            record?.excerpt &&
            record.sha256 &&
            excerptSupportsClaim(claim, record.excerpt),
        )
        .filter((claim, index, claims) => claims.indexOf(claim) === index)
        .slice(0, 6);
      const confirmationNeeded = [
        ...commercialKinds.map((kind) => supplierConfirmationText[kind]),
        ...cleanSemanticList(item?.confirmationNeeded),
      ]
        .filter(Boolean)
        .filter((claim, index, claims) => claims.indexOf(claim) === index)
        .slice(0, 6);
      return supplier &&
        url &&
        openedAt &&
        observedClaims.length &&
        confirmationNeeded.length &&
        sourceWasOpened({ url }, job)
        ? {
            supplier,
            url,
            openedAt,
            observedClaims,
            confirmationNeeded,
          }
        : null;
    })
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeFollowUpActor(value, fallback = "internal") {
  return ["customer", "supplier", "internal", "none"].includes(value)
    ? value
    : fallback;
}

function normalizeResearch(
  value,
  job,
  matchByName = false,
  targetLabel = "",
  evidence = [],
) {
  const rawSummary = cleanSemanticCopy(value?.summary);
  const rawSourceCount = Array.isArray(value?.sources)
    ? value.sources.length
    : 0;
  const sources = Array.isArray(value?.sources)
    ? value.sources
      .map((source) => ({
          title: safeOpenedSourceTitle(source?.title),
          url: canonicalPublicHttpsUrl(source?.url),
          checkedAt: cleanSourceText(source?.checkedAt, 40),
          fact: cleanSemanticCopy(source?.fact).slice(0, 420),
        }))
        .filter(
          (source) =>
            source.title && source.url && source.checkedAt && source.fact &&
            (() => {
              const record = sourceRecordFor(source, job);
              return Boolean(
                record?.excerpt &&
                  record.sha256 &&
                  webClaimSupportsExcerpt(
                    source.fact,
                    record.excerpt,
                    source.title,
                    job,
                  ) &&
                  (!containsUnsupportedPersonalInference(
                    source.fact,
                    targetLabel,
                  ) ||
                    allowsGroundedWebPersonalReference(
                      source.fact,
                      {
                        kind: "web",
                        ...source,
                        excerpt: record.excerpt,
                        sha256: record.sha256,
                      },
                      targetLabel,
                      { job, evidence },
                    )),
              );
            })(),
        )
        .slice(0, 3)
    : [];
  const openedUrls = openedSourceUrlSet(job);
  const openedCount = sources.filter((source) =>
    openedUrls.has(comparableHttpUrl(source.url)),
  ).length;
  const checked =
    sources.length > 0 &&
    sources.length === rawSourceCount &&
    openedCount === sources.length;
  const nameMatch =
    matchByName && sources.length ? "Совпадение по названию. " : "";
  const safeSources = sources.map((source) => {
    const opened = openedUrls.has(comparableHttpUrl(source.url));
    return {
      ...source,
      fact: opened
        ? `${matchByName ? "Совпадение по названию: " : ""}${safeOpenedResearchFact(source.fact)}`
        : `${nameMatch}Ссылка сохранена для проверки. Решение опирается на письмо, каталог и склад.`,
    };
  });
  const summarySource = sources[0];
  const summaryRecord = summarySource
    ? sourceRecordFor(summarySource, job)
    : null;
  const safeSummaryCandidate = safeOpenedResearchFact(rawSummary);
  const safeSummary =
    !containsUnsupportedPersonalInference(safeSummaryCandidate, targetLabel) ||
    (summarySource &&
      summaryRecord?.excerpt &&
      summaryRecord.sha256 &&
      allowsGroundedWebPersonalReference(
        safeSummaryCandidate,
        {
          kind: "web",
          ...summarySource,
          excerpt: summaryRecord.excerpt,
          sha256: summaryRecord.sha256,
        },
        targetLabel,
        { job, evidence },
      ))
      ? safeSummaryCandidate
      : "";
  const summary = checked
    ? `${nameMatch}${safeSummary || "Агент открыл сохранённые страницы и собрал сведения для решения."}`
    : sources.length
      ? `${nameMatch}Агент сохранил ссылки для проверки. Решение опирается на открытые страницы и внутренние данные.`
      : rawSourceCount
        ? `${nameMatch}Непроверенные ссылки отброшены. Решение опирается на письмо, каталог и склад.`
      : value?.checked || rawSummary
        ? `${nameMatch}Поиск завершён. Решение опирается на письмо и внутренние данные.`
        : "";

  return {
    checked,
    summary:
      summary.length > 700
        ? `${summary.slice(0, 699).replace(/\s+\S*$/, "")}…`
        : summary,
    sources: safeSources,
  };
}

function evidenceSourceLabel(source) {
  if (source.kind === "message") return "Письмо клиента";
  if (source.kind === "vision") return "Наблюдение по фото";
  if (source.kind === "web") return source.title;
  return {
    catalog: "Каталог",
    inventory: "Остаток на момент расчёта",
    supplier: "Подтверждённые данные поставщика",
  }[source.dataset];
}

function evidenceCheckedAt(source) {
  if (source.kind === "web") return source.openedAt;
  if (source.kind === "snapshot") return source.checkedAt;
  return new Intl.DateTimeFormat("ru-RU").format(new Date());
}

function normalizeV2Envelope(value, demoData, job) {
  if (value?.schemaVersion !== 2) return null;
  const storedVisionObservation = normalizeVisionObservation(
    job?.visionObservation,
  );
  const visionObservation =
    storedVisionObservation && !hasSensitiveDraftText(storedVisionObservation)
      ? storedVisionObservation
      : null;
  const groundingJob = { ...job, visionObservation };
  const resolvedIntent = normalizeResolvedIntent(
    value.resolvedIntent,
    groundingJob,
    demoData,
  );
  if (!resolvedIntent) {
    throw new Error(
      "Ответ модели содержит некорректный resolvedIntent. Запустите обработку заказа снова.",
    );
  }

  const ambiguous = resolvedIntent.target.state === "ambiguous";
  const suppressUnsupportedAttribution =
    !resolvedIntent.evidence.some(
      (item) => item.source.kind === "web" && !isNeutralOpenedEvidence(item),
    ) && draftHasUnsupportedNamedAttribution(value, groundingJob, demoData);
  const normalizedEstimates = (ambiguous
    ? []
    : normalizeEstimates(value.estimates, resolvedIntent, demoData)).map(
      (estimate) => suppressUnsupportedAttribution
        ? { ...estimate, method: "Диапазонная оценка по подтверждённым данным заявки." }
        : estimate,
    );
  const estimates = canonicalFencePlanningEstimates(
    normalizedEstimates.some((item) => item.metric === "surface_area") &&
    !normalizedEstimates.some((item) => item.metric === "paint_quantity")
      ? []
      : normalizedEstimates,
    resolvedIntent,
    demoData,
    job,
  );
  const rawEstimateCount = Array.isArray(value.estimates)
    ? value.estimates.length
    : 0;
  const rawProductSku =
    resolvedIntent.target.state === "resolved"
      ? cleanSourceText(value.product?.sku, 40).toUpperCase()
      : "";
  const rawProduct = rawProductSku
    ? demoData.products.find((product) => product.sku === rawProductSku)
    : null;
  const compatibleProducts = demoData.products.filter((product) =>
    productSupportsIntent(product, resolvedIntent),
  );
  const trustedCustomerText = latestCustomerText(job);
  const trustedTargetSku = explicitSkuFromText(trustedCustomerText);
  const trustedKnownSkus = [
    ...new Set(
      trustedCustomerText.match(/кр-\d{1,4}/giu)?.map((sku) => sku.toUpperCase()) ?? [],
    ),
  ].filter((sku) => demoData.products.some((product) => product.sku === sku));
  const trustedQuantity = quantityFromText(trustedCustomerText);
  const exactlyOneKnownTrustedSku =
    trustedKnownSkus.length === 1 && trustedTargetSku === trustedKnownSkus[0];
  const evidenceNamesProduct = Boolean(
    rawProductSku &&
      resolvedIntent.evidence.some(
        (item) =>
          item.source?.kind === "message" &&
          item.source.quote?.toUpperCase().includes(rawProductSku),
      ),
  );
  const targetNamesProduct = Boolean(
    rawProductSku &&
      resolvedIntent.target.state === "resolved" &&
      !isHumanTarget(resolvedIntent.target.label) &&
      [rawProductSku, `${rawProductSku} ${rawProduct?.name ?? ""}`]
        .map((value) => normalizedEvidenceText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim())
        .includes(
          normalizedEvidenceText(resolvedIntent.target.label)
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim(),
        ),
  );
  const targetIsCanonicalProductName = Boolean(
    rawProduct &&
      normalizedEvidenceText(resolvedIntent.target.label) ===
        normalizedEvidenceText(rawProduct.name),
  );
  const productTargetGrounded =
    !rawProductSku ||
    Boolean(
      rawProduct &&
        (trustedTargetSku
          ? (!targetIsCanonicalProductName &&
              productSupportsIntent(rawProduct, resolvedIntent)) ||
            (!isHumanTarget(resolvedIntent.target.label) &&
              exactlyOneKnownTrustedSku &&
              trustedTargetSku === rawProductSku) ||
            (targetNamesProduct &&
              (trustedTargetSku === rawProductSku || evidenceNamesProduct))
          : compatibleProducts.length === 1 &&
            compatibleProducts[0].sku === rawProductSku),
    );
  const hasGroundedProduct = Boolean(
    rawProductSku &&
      rawProduct &&
      productTargetGrounded &&
      trustedQuantity > 0 &&
      Number.isFinite(Number(value.product?.requestedKg)) &&
      Number(value.product.requestedKg) > 0,
  );
  const requestedCommitment = ["none", "estimate", "commercial_offer"].includes(
    value.commitment,
  )
    ? value.commitment
    : "none";
  const commitment = ambiguous
    ? "none"
    : !productTargetGrounded
      ? "none"
    : requestedCommitment === "commercial_offer" && !hasGroundedProduct
      ? "none"
    : requestedCommitment === "estimate" && estimates.length === 0
      ? "none"
      : requestedCommitment;
  const rawEvidenceCount = Array.isArray(value.resolvedIntent?.evidence)
    ? value.resolvedIntent.evidence.length
    : 0;
  const normalizedAuthoredEvidenceCount = resolvedIntent.evidence.filter(
    (item) => !isNeutralOpenedEvidence(item),
  ).length;
  const normalizedResearch = normalizeResearch(
    value.research,
    groundingJob,
    false,
    resolvedIntent.target.label,
    resolvedIntent.evidence,
  );
  const openedResearchSources = normalizedResearch.sources.filter((source) =>
    sourceWasOpened(source, groundingJob),
  );
  const research = {
    checked:
      normalizedResearch.checked &&
      openedResearchSources.length === normalizedResearch.sources.length,
    summary: openedResearchSources.length
      ? normalizedResearch.summary
      : normalizedResearch.sources.length
        ? "Непроверенные ссылки отброшены; решение опирается на внутренние данные."
        : normalizedResearch.summary,
    sources: openedResearchSources,
  };
  const supplierLeads = ambiguous
    ? []
    : normalizeSupplierLeads(value.supplierLeads, groundingJob);
  const leadEvidenceUrls = new Set(
    resolvedIntent.evidence
      .filter((item) => {
        const source = objectRecord(item.source);
        return source?.kind === "web" &&
          verifiedOpenedExcerpt(source.excerpt, source.sha256);
      })
      .map((item) => comparableHttpUrl(item.source.url))
      .filter(Boolean),
  );
  const leadEvidenceIds = new Set(
    resolvedIntent.evidence.map((item) => item.id),
  );
  for (const lead of supplierLeads) {
    const comparableUrl = comparableHttpUrl(lead.url);
    if (!comparableUrl || leadEvidenceUrls.has(comparableUrl)) continue;
    const toolEvidence = neutralOpenedEvidence(
      groundingJob,
      leadEvidenceIds,
      lead.url,
    );
    if (!toolEvidence) continue;
    resolvedIntent.evidence.push(toolEvidence);
    leadEvidenceIds.add(toolEvidence.id);
    leadEvidenceUrls.add(comparableUrl);
  }

  return {
    resolvedIntent,
    commitment,
    estimates,
    supplierLeads,
    visionObservation,
    reply: {
      subject:
        (!suppressUnsupportedAttribution
          ? safeAuthoredFragments(value.reply?.subject, demoData?.products ?? [], 1, {
              allowFragment: true,
            })[0]
          : "") ??
        "",
      body: suppressUnsupportedAttribution
        ? ""
        : safeAuthoredFragments(
            value.reply?.body,
            demoData?.products ?? [],
            5,
          ).join(" "),
    },
    allEvidenceGrounded:
      rawEvidenceCount > 0 &&
      rawEvidenceCount === normalizedAuthoredEvidenceCount,
    allEstimatesGrounded: rawEstimateCount === estimates.length,
    productTargetGrounded,
    hasGroundedProduct,
    product: hasGroundedProduct
      ? {
          sku: rawProduct.sku,
          name: rawProduct.name,
          stockKg: rawProduct.stockKg,
          requestedKg: trustedQuantity,
          pricePerKg: rawProduct.pricePerKg,
          total: trustedQuantity * rawProduct.pricePerKg,
          replenishmentDays: rawProduct.replenishmentDays,
        }
      : null,
    hasUnconfirmedSupplierLeads: supplierLeads.length > 0,
    research,
  };
}

function groundedV2Basis(intent) {
  return intent.evidence
    .filter((item) => !isNeutralOpenedEvidence(item))
    .slice(0, 6)
    .map((item) => ({
      fact: item.claim,
      source: evidenceSourceLabel(item.source),
      checkedAt: evidenceCheckedAt(item.source),
      stockVersion:
        item.source.kind === "snapshot" ? item.source.version : "",
    }));
}

function v2Sources(intent) {
  return [
    ...new Set(
      intent.evidence
        .filter((item) => !isNeutralOpenedEvidence(item))
        .map((item) => evidenceSourceLabel(item.source)),
    ),
  ];
}

function safeV2ManagerOptions(options) {
  return options.map((option) => ({
    ...option,
    followUpActor: normalizeFollowUpActor(option.followUpActor),
  }));
}

const authoredNumberPattern =
  /(?:\d|(?:^|[^\p{L}\p{N}_])(?:ноль|один|одна|одно|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать|тридцать|сорок|пятьдесят|сто|тысяча|тысячи|тысяч|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)(?=$|[^\p{L}\p{N}_]))/iu;
const authoredQuestionPattern =
  /(?:\?|(?:^|[^\p{L}\p{N}_])(?:уточн\p{L}*|сообщ\p{L}*|подскаж\p{L}*|ответьте|скажите|укаж\p{L}*|пришл\p{L}*|предостав\p{L}*|напишите|какой|какая|какое|какие|сколько|куда|когда|что\s+именно)(?=$|[^\p{L}\p{N}_]))/iu;
const authoredCommercialClaimPattern =
  /(?:\bRAL\b|₽|\b(?:SKU|артикул\p{L}*|price|stock|availability|delivery|shipping|guarantee|reserve)\b|(?:^|[^\p{L}\p{N}_])(?:цен\p{L}*|стоимост\p{L}*|руб\p{L}*|скидк\p{L}*|оплат\p{L}*|налич\p{L}*|склад\p{L}*|остат\p{L}*|дефицит\p{L}*|резерв\p{L}*|брон\p{L}*|отгруз\p{L}*|поставк\p{L}*|достав\p{L}*|срок\p{L}*|гарант\p{L}*|обеспеч\p{L}*|полный\s+объ[её]м|коммерческ\p{L}*\s+предлож\p{L}*|руководител\p{L}*)(?=$|[^\p{L}\p{N}_]))/iu;
const authoredIntrinsicSafetyClaimPattern =
  /(?:^|[^\p{L}\p{N}_])(?:небезопас\p{L}*|опас\p{L}*|токсич\p{L}*|вред\p{L}*|безвред\p{L}*|ядовит\p{L}*|канцероген\p{L}*|гипоаллерген\p{L}*|огнестойк\p{L}*|пожаробезопас\p{L}*|термостойк\p{L}*|жаростойк\p{L}*|пищев\p{L}*|здоров\p{L}*|non[- ]?toxic|food[- ]?(?:safe|contact)|heat[- ]?resistant|fire[- ]?(?:safe|resistant)|temperature[- ]?resistant|dangerous)(?=$|[^\p{L}\p{N}_])/iu;
const authoredTemperatureTermPattern =
  /(?:^|[^\p{L}\p{N}_])температур\p{L}*(?=$|[^\p{L}\p{N}_])/iu;
const authoredTemperatureVerificationPattern =
  /(?:подбер(?:ем|ём)|проверим|сверим|уточним|подтвердим)[^.!?;\n]{0,80}температур\p{L}*/iu;
const authoredSafetyVerificationPattern =
  /(?:(?:подбер(?:ем|ём|ёмся|ать)|провер(?:им|ить|яем)|свер(?:им|ить)|уточн(?:им|ить)|подтверд(?:им|ить)|найд(?:ем|ём|ёмся|ти)|ищ(?:ем|у|ут)|поиск\p{L}*|запрос(?:им|ить|\p{L}*))[!,:\s—-]*[^.!?;\n]{0,120}(?:термостойк\p{L}*|жаростойк\p{L}*|пищев\p{L}*|безопас\p{L}*|температур\p{L}*)|(?:термостойк\p{L}*|жаростойк\p{L}*|пищев\p{L}*|температур\p{L}*)[^.!?;\n]{0,120}(?:подбер(?:ем|ём|ать)|провер(?:им|ить|яем)|свер(?:им|ить)|уточн(?:им|ить)|подтверд(?:им|ить)|найд(?:ем|ём|ти)|ищ(?:ем|у|ут)|поиск\p{L}*|запрос(?:им|ить|\p{L}*)))/iu;
const authoredVerificationContextPattern =
  /(?:(?:подбер\p{L}*|провер\p{L}*|свер\p{L}*|уточн\p{L}*|найд\p{L}*|ищ\p{L}*|запрос\p{L}*|предлож\p{L}*)[^.!?\n]{0,180}(?:температур\p{L}*|сертифик\p{L}*|документ\p{L}*|материал\p{L}*|услови\p{L}*\s+эксплуатац\p{L}*|област\p{L}*\s+применен\p{L}*|назначен\p{L}*|совместим\p{L}*|пригодн\p{L}*)|(?:температур\p{L}*|сертифик\p{L}*|документ\p{L}*|материал\p{L}*|услови\p{L}*\s+эксплуатац\p{L}*|област\p{L}*\s+применен\p{L}*|назначен\p{L}*|совместим\p{L}*|пригодн\p{L}*)[^.!?\n]{0,180}(?:подбер\p{L}*|провер\p{L}*|свер\p{L}*|уточн\p{L}*|найд\p{L}*|ищ\p{L}*|запрос\p{L}*|предлож\p{L}*))/iu;
const authoredConfirmationClaimPattern =
  /(?:^|[^\p{L}\p{N}_])(?:подтвержд[её]н\p{L}*|подтвердил\p{L}*|confirmed|guaranteed)(?=$|[^\p{L}\p{N}_])/iu;
const authoredRiskSafetyRhetoricPattern =
  /рисковать[^.!?;\n]{0,100}(?:безопас\p{L}*|здоров\p{L}*)/iu;
const authoredToneMetaPattern =
  /(?:^|[^\p{L}\p{N}_])(?:без|не\s+буд\p{L}*|не\s+стан\p{L}*)[^.!?;\n]{0,100}(?:сарказ\p{L}*|подкол\p{L}*|насмеш\p{L}*|оскорб\p{L}*|провокац\p{L}*|хамств\p{L}*|агресси\p{L}*|при[её]м\p{L}*|sarcasm|taunt\p{L}*|insult\p{L}*|provocation|hostility)(?=$|[^\p{L}\p{N}_])/iu;
const authoredCalibrationPattern =
  /(?:понял\p{L}*|понима\p{L}*|виж\p{L}*|разбер\p{L}*|зафиксир\p{L}*|принял\p{L}*|задач\p{L}*\s+понят\p{L}*)/iu;
const authoredPositiveSafetyClaimPattern =
  /(?:^|[^\p{L}\p{N}_])безопас\p{L}*(?=$|[^\p{L}\p{N}_])/iu;
const authoredSafetySubjectPattern =
  /(?:^|[^\p{L}\p{N}_])(?:материал\p{L}*|покрыт\p{L}*|краск\p{L}*|эмал\p{L}*|состав\p{L}*|контакт\p{L}*|применен\p{L}*|использован\p{L}*)(?=$|[^\p{L}\p{N}_])/iu;
const authoredNegativeSafetyBoundaryPattern =
  /(?:(?:термостойк\p{L}*|жаростойк\p{L}*|пищев\p{L}*|безопас\p{L}*|температур\p{L}*)[^.!?;\n]{0,140}(?:не\s+подтвержд\p{L}*|не\s+указан\p{L}*|нет\s+подтвержд\p{L}*)|(?:не\s+подтвержд\p{L}*|не\s+указан\p{L}*|нет\s+подтвержд\p{L}*)[^.!?;\n]{0,140}(?:термостойк\p{L}*|жаростойк\p{L}*|пищев\p{L}*|безопас\p{L}*|температур\p{L}*))/iu;
const authoredOptionPromisePattern =
  /(?:(?:^|[^\p{L}\p{N}_])(?:подтвержда\p{L}*|гарантир\p{L}*|отгруз\p{L}*|постав(?:им|ляем|ить|лен)\p{L}*|достав\p{L}*|обеспеч\p{L}*|закр(?:оем|ываем|ыть|ыт)\p{L}*|зарезервир\p{L}*)(?=$|[^\p{L}\p{N}_])|в\s+наличии|есть\s+на\s+складе|цен\p{L}*\s+(?:состав|будет|зафиксирован)\p{L}*)/iu;
const authoredUnsupportedPropertyPattern =
  /(?:магическ\p{L}*|волшебн\p{L}*|чудесн\p{L}*)/iu;
const leadingVocativePattern =
  /^(?:[\p{Lu}][\p{L}\p{M}'’.-]{1,40}\s+){0,2}[\p{Lu}][\p{L}\p{M}'’.-]{1,40},\s*(?=\p{Lu})/u;

function cleanAuthoredCopy(value) {
  return cleanClientCopy(value).replace(leadingVocativePattern, "").trim();
}

function hasUnsupportedSafetyClaim(value) {
  const verification = authoredSafetyVerificationPattern.test(value);
  const negativeBoundary = authoredNegativeSafetyBoundaryPattern.test(value);
  return (
    authoredRiskSafetyRhetoricPattern.test(value) ||
    (authoredIntrinsicSafetyClaimPattern.test(value) &&
      !verification &&
      !negativeBoundary) ||
    (authoredTemperatureTermPattern.test(value) &&
      !authoredTemperatureVerificationPattern.test(value) &&
      !verification &&
      !negativeBoundary) ||
    (authoredPositiveSafetyClaimPattern.test(value) &&
      authoredSafetySubjectPattern.test(value) &&
      !verification)
  );
}

function hasUnsupportedConfirmationClaim(value) {
  return (
    authoredConfirmationClaimPattern.test(value) &&
    !authoredVerificationContextPattern.test(value)
  );
}

function safeAuthoredFragments(
  value,
  products,
  limit = 2,
  { allowFragment = false } = {},
) {
  const candidate = text(value).trim();
  if (!candidate) return [];
  const sentences = candidate.match(/[^.!?\n]+[.!?]+/gu) ?? [];
  const candidates =
    allowFragment && sentences.length === 0 ? [candidate] : sentences;
  return candidates
    .map((item) => cleanAuthoredCopy(item.trim()))
    .filter(
      (item) =>
        item &&
        lexicalRoots(item).length >= 2 &&
        /^(?:[«„“"'([{]*\s*[\p{Lu}\d]|[—–-]\s*[\p{L}\d])/u.test(item) &&
        !containsUnsupportedPersonalInference(item) &&
        !authoredToneMetaPattern.test(item) &&
        (!authoredQuestionPattern.test(item) ||
          authoredTemperatureVerificationPattern.test(item)) &&
        !authoredNumberPattern.test(item) &&
        !authoredCommercialClaimPattern.test(item) &&
        !authoredUnsupportedPropertyPattern.test(item) &&
        !hasUnsupportedSafetyClaim(item) &&
        !hasUnsupportedConfirmationClaim(item) &&
        !authoredOptionPromisePattern.test(item) &&
        !mentionedProduct(item, products),
    )
    .slice(0, limit);
}

function replyWithAuthoredLead(
  canonical,
  authored,
  products,
  limit = 2,
  { requireCalibration = false } = {},
) {
  const subject = safeAuthoredFragments(authored?.subject, products, 1, {
    allowFragment: true,
  })[0];
  const lead = safeAuthoredFragments(authored?.body, products, limit).join(" ");
  const calibrated = authoredCalibrationPattern.test(
    lead.split(/[.!?]+/u)[0] ?? "",
  );
  return {
    subject: subject || canonical.subject,
    body: !lead
      ? canonical.body
      : requireCalibration && !calibrated
        ? `${canonical.body}\n\n${lead}`
        : `${lead}\n\n${canonical.body}`,
  };
}

function safeBoundaryAction(value, products) {
  return safeAuthoredFragments(value, products, 16).find((item) =>
    authoredSafetyVerificationPattern.test(item),
  );
}

export function ambiguityReply(question, choices = []) {
  const safeChoices = canonicalTargetChoices(choices);
  const ownership = "; я уточню только объект и продолжу без повторных вопросов.";
  const mirrorPrefix = "Вижу несколько одинаково правдоподобных целей — ";
  const mirrorChoices = safeChoices.join(" и ");
  const defaultLead =
    safeChoices.length > 0 &&
      `${mirrorPrefix}${mirrorChoices}${ownership}`.length <= 180
      ? `${mirrorPrefix}${mirrorChoices}${ownership}`
      : `Вижу несколько одинаково правдоподобных целей${ownership}`;
  return {
    subject: "Уточнение по задаче",
    // ponytail: one target blocker has one canonical, candidate-bound preface.
    body: `${defaultLead}\n\n${canonicalTargetQuestion(safeChoices, question)}`,
  };
}

function canonicalTargetQuestion(choices, fallback = "Что красим?") {
  const labels = canonicalTargetChoices(choices);
  if (labels.length >= 2) return `Что красим: ${labels.join(" или ")}?`;
  const cleanFallback = cleanCopy(fallback).replace(/\?/gu, "").replace(/[.!]+$/gu, "").trim();
  return `${cleanFallback || "Что красим"}?`;
}

function canonicalTargetLabel(value) {
  return cleanSemanticCopy(value)
    .replace(/\?/gu, "")
    .replace(/[.!]+$/gu, "")
    .trim();
}

function canonicalTargetChoices(choices) {
  return choices
    .map((choice) => cleanCopy(canonicalTargetLabel(choice)))
    .filter(Boolean)
    .slice(0, 6);
}

function canonicalTargetCandidates(candidates) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      label: canonicalTargetLabel(candidate?.label),
    }))
    .filter((candidate) => candidate.label)
    .slice(0, 6);
}

function safeAuthoredV2ManagerOptions(value, products, allowedActors) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((raw) => {
      const id = cleanIdentifier(raw?.id, 80);
      const option = {
        id,
        title: cleanAuthoredCopy(raw?.title),
        rationale: cleanAuthoredCopy(raw?.rationale),
        tradeoff: cleanAuthoredCopy(raw?.tradeoff),
        reply: cleanAuthoredCopy(raw?.reply),
        followUpActor: normalizeFollowUpActor(raw?.followUpActor),
      };
      const copy = [
        option.title,
        option.rationale,
        option.tradeoff,
        option.reply,
      ].join(" ");
      if (
        !id ||
        seen.has(id) ||
        !option.title ||
        !option.rationale ||
        !option.tradeoff ||
        !option.reply ||
        !allowedActors.includes(option.followUpActor) ||
        containsPersonalInference(copy) ||
        authoredQuestionPattern.test(copy) ||
        authoredNumberPattern.test(copy) ||
        authoredCommercialClaimPattern.test(copy) ||
        authoredUnsupportedPropertyPattern.test(copy) ||
        hasUnsupportedSafetyClaim(copy) ||
        hasUnsupportedConfirmationClaim(copy) ||
        authoredOptionPromisePattern.test(copy) ||
        mentionedProduct(copy, products)
      ) {
        return null;
      }
      seen.add(id);
      return option;
    })
    .filter(Boolean)
    .slice(0, 3);
}

function completeManagerOptions(authored, fallback) {
  const ids = new Set(authored.map((option) => option.id));
  return [
    ...authored,
    ...fallback.filter((option) => !ids.has(option.id)),
  ].slice(0, 3);
}

function v2ReviewOptions() {
  return [
    {
      id: "internal-check",
      title: "Проверить предложение внутри компании",
      rationale:
        "Сверить товар, расчёт, остаток и полномочия до ответа клиенту.",
      tradeoff: "Ответ уйдёт после внутренней проверки.",
      reply:
        "Запрос принят. Проверяем расчёт и условия поставки, затем направим подтверждённое предложение.",
      followUpActor: "internal",
    },
    {
      id: "prepare-estimate",
      title: "Подготовить безопасную оценку",
      rationale:
        "Собрать диапазон по подтверждённым фактам без коммерческого обещания.",
      tradeoff: "Точная цена появится после проверки исходных данных.",
      reply:
        "Подготовим предварительный диапазон и отдельно подтвердим точную цену и срок.",
      followUpActor: "internal",
    },
  ];
}

function v2BoundaryOptions(value) {
  const options = [];
  const lead = value?.supplierLeads?.[0];
  if (lead) {
    options.push({
      id: "verify-supplier-fit",
      title: `Проверить внешний вариант у «${lead.supplier}»`,
      rationale:
        "Запросить совместимость с материалом основания и условиями эксплуатации, а также наличие, цену и срок.",
      tradeoff:
        "Публичная страница показывает только направление поиска; условия поставщика пока не подтверждены.",
      reply:
        "У найденного поставщика проверяем совместимость с материалом основания и условиями эксплуатации, затем отдельно подтвердим коммерческие условия.",
      followUpActor: "supplier",
    });
  } else if (value?.research?.sources?.length) {
    options.push({
      id: "verify-research-fit",
      title: "Сверить найденное решение с областью применения",
      rationale:
        "Проверить материал основания, условия эксплуатации и связь открытого источника с задачей.",
      tradeoff:
        "Открытая страница ещё не подтверждает пригодность конкретной системы.",
      reply:
        "Сверяем найденное направление с материалом основания и условиями эксплуатации до рекомендации.",
      followUpActor: "internal",
    });
  } else {
    options.push({
      id: "verify-catalog-fit",
      title: "Проверить соответствие области применения",
      rationale:
        "Сверить материал основания и условия эксплуатации с назначением систем в каталоге.",
      tradeoff:
        "Точный товар появится только после подтверждения совместимости.",
      reply:
        "Проверяем материал основания и условия эксплуатации по области применения каталога до рекомендации.",
      followUpActor: "internal",
    });
  }
  options.push({
    id: "catalog-fit-alternative",
    title: "Подготовить безопасную каталожную альтернативу",
    rationale:
      "Сопоставить материал основания и условия эксплуатации с областью применения нашего каталога.",
    tradeoff:
      "Если совместимой строительной системы нет, потребуется специализированное покрытие вне текущего каталога.",
    reply:
      "Параллельно проверяем наш каталог по тем же условиям; при отсутствии совместимого варианта обозначим подходящий класс специализированного покрытия без неподтверждённого обещания.",
    followUpActor: "internal",
  });
  return options;
}

function v2BoundaryReply(
  targetLabel,
  value,
  { verifyTemperature = false } = {},
) {
  const firstStep = value?.supplierLeads?.length
    ? "У найденного поставщика проверим совместимость с материалом основания и условиями эксплуатации."
    : value?.research?.sources?.length
      ? "Открытый источник сверим с материалом основания и условиями эксплуатации."
      : "Сверим материал основания и условия эксплуатации с областью применения каталога.";
  return {
    subject: "Следующий шаг по задаче",
    body: `Понял: нужен рабочий результат для задачи «${targetLabel}». Сейчас строительное покрытие нельзя рекомендовать без подтверждения совместимости. Его пригодность пока не подтверждена. ${firstStep}${verifyTemperature ? " Проверим допустимую рабочую температуру и область применения по документам до рекомендации." : ""} Предлагаю параллельно проверить каталог и подготовить подходящую альтернативу, чтобы сохранить требуемый результат без неподтверждённого обещания; ограничение — при отсутствии совместимой системы понадобится специализированный вариант.`,
  };
}

function v2HumanBoundaryOptions() {
  return [
    {
      id: "prepare-professional-reference",
      title: "Подготовить референс для профильного специалиста",
      rationale:
        "Передать желаемое цветовое направление без рекомендации строительного материала человеку.",
      tradeoff:
        "Конкретный состав и способ применения выбираются в профессиональной категории для человека.",
      reply:
        "Подготовим нейтральный цветовой референс и палитру для профессионального колориста.",
      followUpActor: "internal",
    },
    {
      id: "keep-construction-catalog-boundary",
      title: "Сохранить границу строительного каталога",
      rationale:
        "Не переносить свойства строительных покрытий на человека или часть тела.",
      tradeoff:
        "Продажа из текущего каталога для этой задачи не выполняется.",
      reply:
        "Строительный каталог оставляем вне этой задачи и обозначаем профильный безопасный путь.",
      followUpActor: "internal",
    },
  ];
}

function v2HumanBoundaryReply() {
  return {
    subject: "Граница строительного каталога",
    body:
      "Строительные покрытия не рекомендуем и нельзя использовать на человеке или части тела. Здесь нужен профессиональный продукт, предназначенный именно для такого применения. Мы можем подготовить нейтральный цветовой референс и палитру для профильного колориста, не оценивая внешность человека.",
  };
}

function v2UnknownDesignationReply(targetLabel) {
  const safeTargetLabel = cleanAuthoredCopy(targetLabel);
  const taskMirror = safeTargetLabel
    ? `задачи «${safeTargetLabel}»`
    : "задачи по указанному артикулу";
  return {
    subject: "Проверяемая замена по каталогу",
    body: `Понял: нужна подтверждённая замена для ${taskMirror}. Указанный артикул отсутствует в текущем каталоге, поэтому его свойства, фасовку и оттенок не додумываем. Предлагаю внутри сверить артикул с историей заказов и подготовить варианты по назначению и основанию, чтобы сохранить задачу клиента; ограничение — конкретный товар появится только после этой проверки.`,
  };
}

function manualReviewReply(value) {
  const subject = cleanClientCopy(value?.subject) || "Ответ на ручной проверке";
  const body =
    cleanClientCopy(value?.body) ||
    "Запрос сохранён вместе с безопасным черновиком ответа.";
  const notice =
    "Статус: ручная проверка. До её завершения этот черновик не является коммерческим предложением.";
  return {
    subject,
    body: body.includes(notice) ? body : `${body}\n\n${notice}`,
  };
}

export function isFailClosedTargetAmbiguity(result) {
  const blocker = result?.resolvedIntent?.blocker;
  const question = cleanCopy(blocker?.question);
  const replyBody = cleanClientCopy(result?.reply?.body);
  return Boolean(
    isTargetAmbiguityBoundary(result) &&
      question &&
      result.decision === "clarify" &&
      result.calculation === undefined &&
      Array.isArray(result.missing) &&
      result.missing.length === 1 &&
      result.missing[0] === question &&
      replyBody,
  );
}

export function managerFallbackAgentResult(
  job = {},
  {
    reviewerModel = "deepseek/deepseek-v4-flash",
    reason = "Результат рабочей модели требует ручной проверки.",
  } = {},
) {
  const now = new Date().toISOString();
  const safeReason =
    cleanCopy(reason) || "Результат рабочей модели требует ручной проверки.";
  const safeReviewerModel =
    cleanSourceText(reviewerModel, 120) || "deepseek/deepseek-v4-flash";
  const roundNo = Number.isSafeInteger(Number(job.roundNo))
    ? Math.max(1, Number(job.roundNo))
    : 1;
  const quote =
    cleanSourceText(job.body, 420) ||
    cleanSourceText(job.subject, 420) ||
    "Свободная заявка клиента";
  const claim = "Заявка клиента сохранена для безопасной ручной проверки";
  const storedVisionObservation = normalizeVisionObservation(
    job.visionObservation,
  );
  return {
    schemaVersion: 2,
    zone: "red",
    decision: "escalate",
    route: "manager",
    confidence: 0.2,
    resolvedIntent: {
      goal: "Безопасно продолжить обработку сохранённой заявки",
      asks: [
        {
          id: "saved-request",
          request: quote.slice(0, 240),
          evidenceIds: ["saved-request"],
        },
      ],
      target: {
        state: "resolved",
        label: "задача из письма клиента",
        evidenceIds: ["saved-request"],
      },
      evidence: [
        {
          id: "saved-request",
          claim,
          confidence: 1,
          source: { kind: "message", roundNo, quote },
        },
      ],
      assumptions: [],
      blocker: null,
    },
    visionObservation:
      storedVisionObservation && !hasSensitiveDraftText(storedVisionObservation)
        ? storedVisionObservation
        : null,
    commitment: "none",
    estimates: [],
    supplierLeads: [],
    understood: [claim],
    missing: [],
    product: null,
    market: {
      checked: false,
      summary: "Публичные цены не используются в аварийном результате.",
      position: "Коммерческая позиция не определена.",
      profitOpportunity: "Решение появится после ручной проверки.",
      items: [],
    },
    research: { checked: false, summary: "", sources: [] },
    businessContext:
      "Письмо сохранено; неподтверждённые данные модели не влияют на решение.",
    zoneReason: safeReason,
    managerNote:
      "Проверьте исходное письмо, каталог, склад и доступные источники.",
    options: v2ReviewOptions(),
    reply: {
      subject: "Заявка передана на проверку",
      body:
        "Запрос сохранён. Подтверждённое предложение подготовим после ручной проверки исходных данных.",
    },
    checks: ["Неполный результат модели не превращён в предложение клиенту"],
    sources: ["Письмо клиента"],
    decisionBasis: [
      {
        fact: claim,
        source: "Письмо клиента",
        checkedAt: now,
        stockVersion: "",
      },
    ],
    review: {
      model: safeReviewerModel,
      verdict: safeReason,
      notes: ["Неподтверждённые поля отброшены."],
    },
  };
}

export function decodeStoredAgentResult(value) {
  const stored = objectRecord(value);
  if (!stored) return null;
  if (stored.schemaVersion === 2) {
    const intent = objectRecord(stored.resolvedIntent);
    const evidence = Array.isArray(intent?.evidence) ? intent.evidence : [];
    const legacyAsk = legacyResolvedAsk(intent, evidence, intent?.goal);
    const decoded =
      intent && !Array.isArray(intent.asks) && legacyAsk
        ? { ...stored, resolvedIntent: { ...intent, asks: [legacyAsk] } }
        : stored;
    return isCompleteAgentResult(decoded)
      ? decoded
      : managerFallbackAgentResult(
          {
            subject: "Сохранённый заказ",
            body:
              "Сохранённый результат не прошёл проверку нового контракта.",
            roundNo: 1,
          },
          {
            reason:
              "Сохранённый результат не прошёл проверку нового контракта.",
          },
        );
  }

  const legacyUnderstanding = cleanList(stored.understood);
  const claims = legacyUnderstanding.length
    ? legacyUnderstanding
    : [
        cleanCopy(stored.businessContext) ||
          cleanCopy(stored.zoneReason) ||
          "Сохранённый результат заказа",
      ];
  const evidence = claims.slice(0, 8).map((claim, index) => ({
    id: `legacy-${index + 1}`,
    claim,
    confidence: 1,
    source: {
      kind: "message",
      roundNo: 1,
      quote: claim,
    },
  }));
  const legacyMissing = cleanList(stored.missing);
  const product = objectRecord(stored.product);
  const legacyZone = ["green", "yellow", "red"].includes(stored.zone)
    ? stored.zone
    : stored.route === "ready" || stored.decision === "quote"
      ? "green"
      : stored.route === "needs_info" ||
          stored.decision === "clarify" ||
          legacyMissing.length > 0
        ? "yellow"
        : "red";
  const legacyRoute = {
    green: "ready",
    yellow: "needs_info",
    red: "manager",
  }[legacyZone];
  const legacyDecision = {
    green: "quote",
    yellow: "clarify",
    red: "escalate",
  }[legacyZone];
  return {
    ...stored,
    schemaVersion: 2,
    zone: legacyZone,
    decision: legacyDecision,
    route: legacyRoute,
    resolvedIntent: {
      goal: "Продолжить сохранённый заказ",
      asks: [
        {
          id: "legacy-request",
          request: evidence[0].source.quote.slice(0, 240),
          evidenceIds: [evidence[0].id],
        },
      ],
      target: {
        state: "resolved",
        label: "задача из сохранённого письма",
        evidenceIds: [evidence[0].id],
      },
      evidence,
      assumptions: [],
      blocker: null,
    },
    ...(legacyMissing.length
      ? {
          legacyBlocker: {
            kind: "legacy_missing",
            questions: legacyMissing,
          },
        }
      : {}),
    visionObservation: null,
    commitment:
      legacyZone === "green" && product
        ? "commercial_offer"
        : "none",
    estimates: [],
    supplierLeads: [],
    understood: evidence.map((item) => item.claim),
    missing: legacyMissing,
    options: Array.isArray(stored.options)
      ? stored.options.map((option) => ({
          ...option,
          followUpActor: normalizeFollowUpActor(
            option?.followUpActor,
            legacyZone === "red" ? "internal" : "customer",
          ),
        }))
      : [],
  };
}

function rangeEstimateReply(
  estimates,
  targetLabel = "объекта",
  demoData,
  requestText = "",
  authoredBody = "",
) {
  const labels = {
    surface_area: "площадь",
    paint_quantity: "краска",
    budget: "бюджет",
  };
  const metricCounts = estimates.reduce((counts, estimate) => {
    counts.set(estimate.metric, (counts.get(estimate.metric) ?? 0) + 1);
    return counts;
  }, new Map());
  const rangeGroups = [];
  const rangeGroupIndexes = new Map();
  for (const estimate of estimates) {
    const method = cleanAuthoredCopy(estimate.method);
    const repeatedMetric = metricCounts.get(estimate.metric) > 1;
    const scope = repeatedMetric
      ? method.match(/^(.{1,80}?)(?::|[—–-]\s)/u)?.[1]?.trim() || method
      : "";
    const key = scope.toLocaleLowerCase();
    let groupIndex = rangeGroupIndexes.get(key);
    if (groupIndex === undefined) {
      groupIndex = rangeGroups.length;
      rangeGroupIndexes.set(key, groupIndex);
      rangeGroups.push({ scope, ranges: [] });
    }
    const label = scope
      ? labels[estimate.metric]
      : `${labels[estimate.metric][0].toLocaleUpperCase()}${labels[
          estimate.metric
        ].slice(1)}`;
    rangeGroups[groupIndex].ranges.push(
      `${label} — ${decimal.format(estimate.range.min)}–${decimal.format(
        estimate.range.max,
      )} ${estimate.range.unit}`,
    );
  }
  const ranges = rangeGroups.map(({ scope, ranges: scopedRanges }) =>
    scope ? `${scope}: ${scopedRanges.join(", ")}` : scopedRanges.join(", "),
  );
  const target = cleanAuthoredCopy(targetLabel) || "объекта";
  const candidateSkus = [
    ...new Set(
      estimates.map((estimate) => estimate.candidateSku).filter(Boolean),
    ),
  ];
  const candidateProduct =
    candidateSkus.length === 1
      ? demoData?.products?.find((product) => product.sku === candidateSkus[0])
      : null;
  const catalogLine = candidateProduct
    ? `Для «${target}» каталог подтверждает ${candidateProduct.sku} — «${candidateProduct.name}»: расход ${decimal.format(
        candidateProduct.coverageKgPerM2PerCoat,
      )} кг/м² на слой, ${decimal.format(
        candidateProduct.recommendedCoats,
      )} ${countedNoun(
        candidateProduct.recommendedCoats,
        "слой",
        "слоя",
        "слоёв",
      )}; цена ${money.format(
        candidateProduct.pricePerKg,
      )} ₽/кг; цвета — ${candidateProduct.colors.join(", ")}.`
    : "";
  const asksForColorAdvice = askColorRequestPattern.test(requestText);
  const preferredColor = candidateProduct
    ? candidateProduct.colors.find((color) =>
        /дерев|забор|дач/iu.test(target) && /коричнев/iu.test(color),
      ) ?? candidateProduct.colors[0]
    : "";
  const authoredLead = safeAuthoredFragments(
    authoredBody,
    demoData?.products ?? [],
    2,
  ).join(" ");
  const colorAdvice = asksForColorAdvice &&
      preferredColor &&
      !normalizedEvidenceText(authoredLead).includes(
        normalizedEvidenceText(preferredColor),
      )
    ? `Для «${target}» я бы выбрал ${preferredColor}: это спокойный вариант из подтверждённой палитры; перед всей работой сделаем пробный выкрас.`
    : "";
  const dimensionRequest =
    /забор/iu.test(target) &&
    !/(?:\d[\d\s.,]*\s*(?:м²|м2|кв\.?\s*м|метр\p{L}*|см)|(?:длин|высот)\p{L}*[^.!?\n]{0,30}\d)/iu.test(
      requestText,
    )
      ? "Чтобы уточнить смету, пришлите длину, среднюю высоту и число окрашиваемых сторон забора."
      : "";
  return {
    subject: "Предварительная оценка по задаче",
    body: [
      `Зафиксировал «${target}». ${ranges.join(". ")}. Это диапазонная оценка.`,
      catalogLine,
      colorAdvice,
      dimensionRequest,
      `Я предлагаю такой шаг: подготовим пробный выкрас для «${target}», чтобы проверить совместимость системы при фактическом освещении; точные коммерческие условия подтвердим перед предложением.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

const englishNumberTokens = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "and",
];
const englishNumberTokenPattern = englishNumberTokens.join("|");
const englishKgPattern = new RegExp(
  `\\b((?:(?:${englishNumberTokenPattern})(?:[\\s-]+|$)){1,12})` +
    "(kilograms?|kilos?|kgs?|tonnes?|tons?)\\b",
  "giu",
);

function parseEnglishNumberWords(value) {
  const units = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };
  let total = 0;
  let group = 0;
  let sawNumber = false;
  for (const token of normalizedEvidenceText(value)
    .replace(/-/gu, " ")
    .split(/\s+/u)) {
    if (token === "and") continue;
    if (Object.hasOwn(units, token)) {
      group += units[token];
      sawNumber = true;
    } else if (token === "hundred") {
      group = Math.max(1, group) * 100;
      sawNumber = true;
    } else if (token === "thousand") {
      total += Math.max(1, group) * 1000;
      group = 0;
      sawNumber = true;
    } else if (token === "million") {
      total += Math.max(1, group) * 1_000_000;
      group = 0;
      sawNumber = true;
    } else {
      return 0;
    }
  }
  return sawNumber ? total + group : 0;
}

function trustedV2MessageRounds(job) {
  return [...messageTextsByRound(job).entries()]
    .sort(([left], [right]) => left - right)
    .map(([roundNo, texts]) => ({
      roundNo,
      texts,
      source: texts.join(" "),
    }))
    .filter((round) => round.source);
}

function parseTrustedNumeric(value) {
  const compact = String(value ?? "").replace(/[ \u00a0\u202f]/gu, "");
  if (!compact) return 0;
  const grouped = /^\d{1,3}(?:[.,]\d{3})+$/u.test(compact);
  const numeric = Number(grouped ? compact.replace(/[.,]/gu, "") : compact.replace(",", "."));
  return Number.isFinite(numeric) ? numeric : 0;
}

function trustedQuantityValues(source) {
  const values = [];
  const numericPattern =
    /(?:^|[^\p{L}\p{N}])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(кг|килограмм\p{L}*|kg|kilogram\p{L}*|kilo\p{L}*|т|тонн\p{L}*|tons?|tonnes?)(?=$|[^\p{L}])/giu;
  for (const match of source.matchAll(numericPattern)) {
    const numeric = parseTrustedNumeric(match[1]);
    const multiplier = /^(?:т|тонн|ton)/iu.test(match[2]) ? 1000 : 1;
    const candidate = numeric * multiplier;
    if (candidate > 0) values.push(candidate);
  }
  for (const match of source.matchAll(englishKgPattern)) {
    const multiplier = /^(?:ton)/iu.test(match[2]) ? 1000 : 1;
    const candidate = parseEnglishNumberWords(match[1]) * multiplier;
    if (candidate > 0) values.push(candidate);
  }
  const russianNumbers = {
    одна: 1,
    одну: 1,
    один: 1,
    пара: 2,
    пару: 2,
    две: 2,
    два: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
    десять: 10,
  };
  for (const match of source.matchAll(
    /(?:^|[^\p{L}])(одна|одну|один|пара|пару|две|два|три|четыре|пять|шесть|семь|восемь|девять|десять)\s+тонн(?:а|ы)?(?=$|[^\p{L}])/giu,
  )) {
    values.push(russianNumbers[match[1].toLocaleLowerCase("ru-RU")] * 1000);
  }
  return values;
}

function explicitTotalTrustedQuantity(source) {
  const match = source.match(
    /(?:всего|итог\p{L}*|общ\p{L}*\s+объ[её]м\p{L}*|заказ\p{L}*)[^.!?\n]{0,60}?(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(кг|килограмм\p{L}*|kg|т|тонн\p{L}*|tons?|tonnes?)/iu,
  );
  if (!match) return 0;
  const numeric = parseTrustedNumeric(match[1]);
  return /^(?:т|тонн|ton)/iu.test(match[2]) ? numeric * 1000 : numeric;
}

function quantityNeedsFailClosed(source) {
  return /(?:\b(?:много|нескольк\p{L}*|примерн\p{L}*|около|не\s+зна\p{L}*|неизвест\p{L}*|неясн\p{L}*)\s*(?:кг|килограмм\p{L}*|\bkg\b|тонн\p{L}*|\btons?\b|\btonnes?\b)|(?:нужн\p{L}*|треб\p{L}*|заказ\p{L}*|объ[её]м\p{L}*|количеств\p{L}*|вес\p{L}*)[^.!?\n]{0,40}(?:кг|килограмм\p{L}*|\bkg\b|тонн\p{L}*|\btons?\b|\btonnes?\b|не\s+(?:указан\p{L}*|определ\p{L}*|понят\p{L}*|ясен)|неясн|неизвест|примерн|около|много|уточн))/iu.test(
    source,
  );
}

function hasAmbiguousQuantity(source) {
  return /\d[\d\s.,]*\s*(?:или|либо|\/)\s*\d[\d\s.,]*\s*(?:кг|килограмм\p{L}*|\bkg\b|тонн\p{L}*|\btons?\b|\btonnes?\b)/iu.test(
    source,
  );
}

function trustedQuantityStateForSource(source) {
  const values = trustedQuantityValues(source);
  if (hasAmbiguousQuantity(source)) {
    return { status: "unresolved", value: 0 };
  }
  const fallback = quantityFromText(source);
  if (!values.length && fallback > 0) {
    return { status: "resolved", value: fallback };
  }
  if (!values.length) {
    return quantityNeedsFailClosed(source)
      ? { status: "unresolved", value: 0 }
      : { status: "none", value: 0 };
  }
  const explicitTotal = explicitTotalTrustedQuantity(source);
  if (explicitTotal > 0) return { status: "resolved", value: explicitTotal };
  const uniqueValues = [...new Set(values)];
  return uniqueValues.length === 1
    ? { status: "resolved", value: uniqueValues[0] }
    : { status: "unresolved", value: 0 };
}

function trustedQuantityState(job) {
  const rounds = trustedV2MessageRounds(job);
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    for (const source of [...rounds[index].texts].reverse()) {
      const state = trustedQuantityStateForSource(source);
      if (state.status !== "none") return state;
    }
  }
  return { status: "none", value: 0 };
}

function requestedKgFromTrustedMessages(job) {
  const state = trustedQuantityState(job);
  return state.status === "resolved" ? state.value : 0;
}

function explicitSkusFromSource(source) {
  const upperSource = source.toLocaleUpperCase("ru-RU");
  return [
    ...new Set(
      [
        ...source.matchAll(/кр-\d{1,4}/giu),
        ...upperSource.matchAll(
          /(?:^|[^\p{L}\p{N}])((?=[\p{Lu}\p{N}-]{4,})(?=[\p{Lu}\p{N}-]*\p{N})[\p{Lu}\p{N}]{2,}(?:-[\p{Lu}\p{N}]{1,})+)(?=$|[^\p{L}\p{N}])/gu,
        ),
      ].map((match) => (match[1] ?? match[0]).trim().toUpperCase()),
    ),
  ];
}

function explicitV2Skus(job) {
  const rounds = trustedV2MessageRounds(job);
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    for (const source of [...rounds[index].texts].reverse()) {
      const skus = explicitSkusFromSource(source);
      if (skus.length) return skus;
    }
  }
  return [];
}

function canonicalV2Product(value, intent, demoData, job) {
  const products = Array.isArray(demoData?.products) ? demoData.products : [];
  if (intent?.target?.state !== "resolved") return null;
  const explicitSkus = explicitV2Skus(job);
  const groundedSkus = [
    ...new Set(
      explicitSkus.filter((sku) =>
        products.some((product) => product.sku === sku),
      ),
    ),
  ];
  if (
    explicitSkus.some((sku) => !groundedSkus.includes(sku)) ||
    groundedSkus.length > 1
  ) {
    return null;
  }
  const modelSku = cleanSourceText(value?.product?.sku, 40).toUpperCase();
  const sku = groundedSkus[0] || modelSku;
  const product = products.find((item) => item.sku === sku);
  const requestedKg = requestedKgFromTrustedMessages(job);
  const targetIsHumanOrBody = isHumanTarget(intent.target.label);
  const catalogGroundedSelection = Boolean(
    product &&
      (productSupportsIntent(product, intent) ||
        (groundedSkus.length === 1 &&
          trustedTargetEvidenceSupportsProduct(product, intent))),
  );
  if (
    !product ||
    !requestedKg ||
    targetIsHumanOrBody ||
    !catalogGroundedSelection
  ) {
    return null;
  }
  return {
    sku: product.sku,
    name: product.name,
    stockKg: Number(product.stockKg),
    requestedKg,
    pricePerKg: Number(product.pricePerKg),
    total: requestedKg * Number(product.pricePerKg),
    replenishmentDays: Number(product.replenishmentDays),
  };
}

function v2EmptyMarket() {
  return {
    checked: false,
    summary: "Коммерческое сравнение не выполнялось.",
    position: "Товар и точные условия не подтверждены.",
    profitOpportunity:
      "Расчёт появится после программной сверки товара и исходных данных.",
    items: [],
  };
}

function v2OfferReply(product, job) {
  const subject =
    cleanCopy(job?.subject) || `Предложение по товару ${product.sku}`;
  return {
    subject: `Предложение по заказу: ${subject}`.slice(0, 240),
    body: `Подтверждаем ${money.format(
      product.requestedKg,
    )} кг краски «${product.name}» по цене ${money.format(
      product.pricePerKg,
    )} ₽/кг. Сумма — ${money.format(
      product.total,
    )} ₽. Весь объём подтверждён складом.`,
  };
}

function v2ShortageReply(product, targetLabel = "") {
  const availableKg = Math.min(product.stockKg, product.requestedKg);
  const missingKg = product.requestedKg - availableKg;
  const target = cleanAuthoredCopy(targetLabel) || "задачу";
  return {
    subject: "План поставки по заказу",
    body: `Зафиксировал «${target}». По нашему складу доступно ${money.format(
      availableKg,
    )} из ${money.format(product.requestedKg)} кг; дефицит — ${money.format(
      missingKg,
    )} кг. Я предлагаю подтвердить партнёрскую поставку и производственный график для дефицита, чтобы собрать полный объём; совместимость, внешний объём, цену и срок подтвердим до предложения.`,
  };
}

function v2ShortageOptions(product, supplierPlan) {
  const availableKg = Math.min(product.stockKg, product.requestedKg);
  const missingKg = product.requestedKg - availableKg;
  const options = [
    {
      id: "split-from-stock",
      title: "Разделить поставку по наличию",
      rationale: `Отгрузить ${money.format(
        availableKg,
      )} кг со склада и поставить ${money.format(
        missingKg,
      )} кг после пополнения.`,
      tradeoff: `Вторая часть ожидается до ${product.replenishmentDays} дней.`,
      reply: `Со склада доступно ${money.format(
        availableKg,
      )} кг. Недостающие ${money.format(
        missingKg,
      )} кг включим в пополнение; точный график подтвердим до отправки предложения.`,
      followUpActor: "internal",
    },
  ];
  if (supplierPlan) {
    options.push({
      id: "confirm-supplier-plan",
      title: `Подтвердить недостающий объём у «${supplierPlan.supplierName}»`,
      rationale: `Снимок поставщика покрывает ${money.format(
        supplierPlan.supplierKg,
      )} кг; срок — ${supplierPlan.deliveryDays} ${countedNoun(
        supplierPlan.deliveryDays,
        "день",
        "дня",
        "дней",
      )}.`,
      tradeoff:
        "Остаток, цена, срок и совместимость подтверждаются напрямую перед ответом клиенту.",
      reply: `Запрашиваем у «${supplierPlan.supplierName}» подтверждение ${money.format(
        supplierPlan.supplierKg,
      )} кг, цены ${money.format(
        supplierPlan.supplierPricePerKg,
      )} ₽/кг и срока ${supplierPlan.deliveryDays} ${countedNoun(
        supplierPlan.deliveryDays,
        "день",
        "дня",
        "дней",
      )}. После подтверждения соберём единый график.`,
      followUpActor: "supplier",
    });
  }
  options.push({
    id: "schedule-production",
    title: "Поставить дефицит в производственный план",
    rationale: `Запланировать недостающие ${money.format(
      missingKg,
    )} кг по подтверждённой спецификации.`,
    tradeoff:
      "Производство и руководитель должны подтвердить дату до ответа клиенту.",
    reply: `Недостающие ${money.format(
      missingKg,
    )} кг переданы на внутреннюю проверку производственного графика. Подтверждённую дату включим в предложение.`,
    followUpActor: "internal",
  });
  return options.slice(0, 3);
}

function canonicalV2Basis(intent, product, supplierPlan, demoData) {
  const basis = groundedV2Basis(intent);
  if (product) {
    const snapshotVersion = String(
      demoData?.inventorySnapshot?.version ?? "demo",
    );
    const checkedAt =
      cleanSourceText(
        demoData.products.find((item) => item.sku === product.sku)
          ?.stockUpdatedAt,
        80,
      ) ||
      cleanSourceText(demoData?.inventorySnapshot?.capturedAt, 80) ||
      "демонстрационный снимок";
    basis.push(
      {
        fact: `Каталог подтверждает ${product.sku}: ${product.name}; цена ${money.format(
          product.pricePerKg,
        )} ₽/кг.`,
        source: "Каталог",
        checkedAt,
        stockVersion: snapshotVersion,
      },
      {
        fact:
          product.requestedKg <= product.stockKg
            ? `Склад подтверждает весь объём: ${money.format(
                product.requestedKg,
              )} из ${money.format(product.stockKg)} кг.`
            : `Склад подтверждает ${money.format(
                product.stockKg,
              )} из ${money.format(product.requestedKg)} кг.`,
        source: "Остаток на момент расчёта",
        checkedAt,
        stockVersion: snapshotVersion,
      },
    );
  }
  if (supplierPlan) {
    basis.push({
      fact: `Снимок «${supplierPlan.supplierName}» покрывает недостающие ${money.format(
        supplierPlan.supplierKg,
      )} кг; перед предложением требуется прямое подтверждение.`,
      source: "Подтверждённые данные поставщика",
      checkedAt: supplierPlan.stockCheckedAt,
      stockVersion: String(
        demoData?.inventorySnapshot?.version ?? "demo",
      ),
    });
  }
  return basis.slice(0, 6);
}

function safeV2Review(value) {
  return {
    model: cleanSourceText(value?.model, 120),
    verdict: cleanCopy(value?.verdict),
    notes: cleanList(value?.notes).slice(0, 4),
  };
}

export function normalizeV2AgentResult(value, demoData, job = {}) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 2) {
    throw new Error("Для v2-нормализации нужен AgentResult schemaVersion=2.");
  }
  if (hasSensitiveDraftText(value)) {
    return managerFallbackAgentResult(job, {
      reason: "Ответ модели содержит credential-подобные данные и закрыт для показа.",
    });
  }

  let envelope;
  try {
    envelope = normalizeV2Envelope(value, demoData, job);
  } catch {
    return managerFallbackAgentResult(job, {
      reason:
        "Resolved intent не прошёл программную проверку и передан руководителю.",
    });
  }

  const { resolvedIntent } = envelope;
  const ambiguous = resolvedIntent.target.state === "ambiguous";
  const quantityState = trustedQuantityState(job);
  const quantityUnresolved = quantityState.status === "unresolved";
  const requestedCommitment = [
    "none",
    "estimate",
    "commercial_offer",
  ].includes(value.commitment)
    ? value.commitment
    : "none";
  const product = ambiguous
    ? null
    : canonicalV2Product(value, resolvedIntent, demoData, job);
  const sourceProduct = product
    ? demoData.products.find((item) => item.sku === product.sku)
    : null;
  const estimateConflictsWithSafetyBoundary =
    requestedCommitment === "estimate" &&
    authoredNegativeSafetyBoundaryPattern.test(text(value.reply?.body));
  const needsTemperatureVerification = authoredTemperatureTermPattern.test(
    text(value.reply?.body),
  );
  const estimates =
    !ambiguous &&
    !quantityUnresolved &&
    requestedCommitment === "estimate" &&
    !estimateConflictsWithSafetyBoundary
      ? envelope.estimates
      : [];
  const explicitSkus = explicitV2Skus(job);
  const unknownExplicitSkus = explicitSkus.filter(
    (sku) => !demoData.products.some((item) => item.sku === sku),
  );
  const unknownExplicitSku = unknownExplicitSkus.length > 0;
  if (unknownExplicitSku) {
    const customerText = latestCustomerText(job);
    let targetStart = -1;
    let targetMarker = "";
    for (const marker of [" for ", " для "]) {
      const index = customerText.lastIndexOf(marker);
      if (index > targetStart) {
        targetStart = index;
        targetMarker = marker;
      }
    }
    let trustedTaskLabel = "";
    if (targetStart >= 0) {
      const remainder = customerText.slice(targetStart + targetMarker.length);
      const boundaries = [".", "!", "?", "\n"]
        .map((marker) => remainder.indexOf(marker))
        .filter((index) => index >= 0);
      const candidate = cleanSemanticCopy(
        remainder.slice(0, boundaries.length ? Math.min(...boundaries) : undefined),
      ).slice(0, 160);
      if (isExplicitNonHumanTarget(candidate)) trustedTaskLabel = candidate;
    }
    resolvedIntent.goal = trustedTaskLabel
      ? `Проверить неподтверждённый артикул для задачи «${trustedTaskLabel}»`
      : "Проверить неподтверждённый артикул из запроса клиента";
    resolvedIntent.assumptions = [];
    resolvedIntent.evidence = resolvedIntent.evidence.map((item) =>
      item.source.kind === "message" && unknownExplicitSkus.some((sku) =>
        item.source.quote.toUpperCase().includes(sku),
      )
        ? {
            ...item,
            claim: trustedTaskLabel
              ? `Клиент указал неподтверждённый артикул для задачи «${trustedTaskLabel}».`
              : "Клиент указал неподтверждённый артикул.",
          }
        : item,
    );
    if (
      resolvedIntent.target.state === "resolved" &&
      unknownExplicitSkus.some((sku) =>
        resolvedIntent.target.label.toUpperCase().includes(sku),
      )
    ) {
      resolvedIntent.target.label = trustedTaskLabel ||
        "неподтверждённый артикул из запроса клиента";
    }
  }
  const exactOffer = requestedCommitment !== "estimate" && Boolean(product);
  const shortage = Boolean(
    exactOffer && product.requestedKg > product.stockKg,
  );
  const supplierPlan = shortage
    ? buildSupplierPlan(
        sourceProduct,
        demoData?.market,
        product.requestedKg,
      )
    : null;
  const commitment = ambiguous
    ? "none"
    : quantityUnresolved
      ? "none"
    : estimates.length > 0
      ? "estimate"
      : exactOffer
        ? "commercial_offer"
        : "none";
  const authoredManagerOptions = ambiguous
    ? []
    : safeAuthoredV2ManagerOptions(
        value.options,
        demoData?.products ?? [],
        ["supplier", "internal", "none"],
      );
  const managerEstimate =
    commitment === "estimate" &&
    hasSpecialTerms(orderText(job)) &&
    (value.zone === "red" ||
      value.decision === "escalate" ||
      value.route === "manager" ||
      (Array.isArray(value.options) && value.options.length >= 2) ||
      authoredManagerOptions.length >= 2);
  const confidenceValue = Math.max(
    0,
    Math.min(1, Number(value.confidence) || 0),
  );
  const sources = [
    ...new Set([
      ...v2Sources(resolvedIntent),
      ...(product ? ["Каталог", "Остаток на момент расчёта"] : []),
      ...(supplierPlan ? ["Подтверждённые данные поставщика"] : []),
    ]),
  ].filter(Boolean);
  const basis = canonicalV2Basis(
    resolvedIntent,
    product,
    supplierPlan,
    demoData,
  );
  const base = {
    schemaVersion: 2,
    confidence: confidenceValue,
    resolvedIntent,
    visionObservation: envelope.visionObservation,
    commitment,
    estimates,
    supplierLeads: envelope.supplierLeads,
    understood: resolvedIntent.evidence
      .filter((item) => !isNeutralOpenedEvidence(item))
      .map((item) => item.claim)
      .filter((claim) =>
        !containsUnsupportedPersonalInference(
          claim,
          resolvedIntent.target?.label,
        ),
      )
      .slice(0, 8),
    missing: [],
    product,
    market: sourceProduct
      ? marketSnapshot(sourceProduct, demoData, product.requestedKg)
      : v2EmptyMarket(),
    research: envelope.research,
    businessContext: product
      ? "Товар, цена и остаток пересобраны из переданного снимка."
      : "Неподтверждённые коммерческие поля модели не используются.",
    zoneReason: "",
    managerNote: "",
    options: [],
    reply: {
      subject: "Проверка запроса",
      body: "Запрос сохранён для безопасной проверки.",
    },
    checks: [
      "Resolved intent проверен программно",
      "Коммерческие числа модели заменены данными снимка",
    ],
    sources: sources.length ? sources : ["Письмо клиента"],
    decisionBasis: basis.length
      ? basis
      : [
          {
            fact: "Запрос сохранён для безопасной проверки.",
            source: "Письмо клиента",
            checkedAt: new Intl.DateTimeFormat("ru-RU").format(new Date()),
            stockVersion: "",
          },
        ],
    review: safeV2Review(value.review),
  };

  const humanBoundaryRequired =
    explicitlyRequestsHumanTarget(latestCustomerText(job)) ||
    isHumanTarget(resolvedIntent.target.label);

  if (humanBoundaryRequired) {
    return {
      ...base,
      zone: "red",
      decision: "escalate",
      route: "manager",
      commitment: "none",
      estimates: [],
      supplierLeads: [],
      product: null,
      market: v2EmptyMarket(),
      zoneReason:
        "Строительные покрытия не предназначены для человека или части тела.",
      managerNote:
        "Не предлагайте строительный товар; сохраните только нейтральный цветовой референс.",
      options: v2HumanBoundaryOptions(),
      reply: v2HumanBoundaryReply(),
    };
  }

  if (ambiguous) {
    const question = resolvedIntent.blocker.question;
    return {
      ...base,
      zone: "yellow",
      decision: "clarify",
      route: "needs_info",
      commitment: "none",
      estimates: [],
      supplierLeads: [],
      missing: [question],
      product: null,
      market: v2EmptyMarket(),
      zoneReason:
        "Несколько объектов действия одинаково правдоподобны.",
      managerNote:
        "Ответ клиента выберет объект; остальные подтверждённые факты сохранятся.",
      reply: ambiguityReply(question, resolvedIntent.blocker.choices),
    };
  }

  if (quantityUnresolved) {
    const targetLabel = cleanAuthoredCopy(resolvedIntent.target.label);
    const boundaryReply = v2BoundaryReply(targetLabel, envelope, {
      verifyTemperature: needsTemperatureVerification,
    });
    const authoredOptions = safeAuthoredV2ManagerOptions(
      value.options,
      demoData?.products ?? [],
      ["supplier", "internal"],
    );
    return {
      ...base,
      zone: "red",
      decision: "escalate",
      route: "manager",
      commitment: "none",
      estimates: [],
      product: null,
      market: v2EmptyMarket(),
      zoneReason:
        "Свежая реплика содержит неразрешимый объём; старые числовые факты не используются.",
      managerNote:
        "Проверьте свежую реплику и исходные данные без нового вопроса клиенту.",
      options: completeManagerOptions(
        authoredOptions,
        v2BoundaryOptions(envelope),
      ),
      reply: replyWithAuthoredLead(
        boundaryReply,
        envelope.reply,
        demoData?.products ?? [],
        5,
        { requireCalibration: true },
      ),
    };
  }

  if (unknownExplicitSku) {
    return {
      ...base,
      zone: "red",
      decision: "escalate",
      route: "manager",
      commitment: "none",
      estimates: [],
      supplierLeads: [],
      product: null,
      market: v2EmptyMarket(),
      zoneReason:
        "Указанный артикул отсутствует в текущем снимке каталога.",
      managerNote:
        "Сверьте код с историей заказов и предложите только подтверждённые варианты.",
      options: v2BoundaryOptions({
        ...envelope,
        supplierLeads: [],
      }),
      reply: v2UnknownDesignationReply(resolvedIntent.target.label),
    };
  }

  if (managerEstimate) {
    return {
      ...base,
      zone: "red",
      decision: "escalate",
      route: "manager",
      product: null,
      market: v2EmptyMarket(),
      zoneReason:
        "Диапазонная оценка готова, но конфликтующие ограничения требуют внутреннего выбора.",
      managerNote:
        "Выберите безопасный следующий шаг; диапазон не является точным коммерческим обещанием.",
      options: completeManagerOptions(
        authoredManagerOptions,
        v2ReviewOptions(),
      ),
      reply: replyWithAuthoredLead(
        rangeEstimateReply(
          estimates,
          resolvedIntent.target.label,
          demoData,
          resolvedIntent.asks.map((ask) => ask.request).join("\n"),
          envelope.reply?.body,
        ),
        envelope.reply,
        demoData?.products ?? [],
        5,
      ),
    };
  }

  if (commitment === "estimate") {
    return {
      ...base,
      zone: "yellow",
      decision: "clarify",
      route: "ready",
      product: null,
      market: v2EmptyMarket(),
      zoneReason:
        "Подтверждённых фактов достаточно для диапазонной оценки.",
      managerNote:
        "Точные цена, резерв и отгрузка появятся только после коммерческой сверки.",
      reply: replyWithAuthoredLead(
        rangeEstimateReply(
          estimates,
          resolvedIntent.target.label,
          demoData,
          resolvedIntent.asks.map((ask) => ask.request).join("\n"),
          envelope.reply?.body,
        ),
        envelope.reply,
        demoData?.products ?? [],
        5,
      ),
    };
  }

  if (commitment === "commercial_offer" && product && !shortage) {
    return {
      ...base,
      zone: "green",
      decision: "quote",
      route: "ready",
      zoneReason: "Товар, точный объём, цена и остаток подтверждены.",
      managerNote: "Коммерческое предложение готово к отдельной проверке.",
      reply: replyWithAuthoredLead(
        v2OfferReply(product, job),
        envelope.reply,
        demoData?.products ?? [],
      ),
    };
  }

  if (commitment === "commercial_offer" && product && shortage) {
    const authoredOptions = safeAuthoredV2ManagerOptions(
      value.options,
      demoData?.products ?? [],
      ["supplier", "internal"],
    );
    return {
      ...base,
      zone: "red",
      decision: "escalate",
      route: "manager",
      ...(supplierPlan ? { supplierPlan } : {}),
      zoneReason:
        "Точный заказ превышает собственный остаток; нужен выбор выполнимого плана.",
      managerNote:
        "Выберите программно рассчитанный план и подтвердите внешние условия до ответа.",
      options: completeManagerOptions(
        authoredOptions,
        v2ShortageOptions(product, supplierPlan),
      ),
      reply: replyWithAuthoredLead(
        v2ShortageReply(product, resolvedIntent.target.label),
        envelope.reply,
        demoData?.products ?? [],
      ),
    };
  }

  const targetLabel = cleanAuthoredCopy(resolvedIntent.target.label);
  const boundaryReply = v2BoundaryReply(targetLabel, envelope, {
    verifyTemperature: needsTemperatureVerification,
  });
  const authoredOptions = safeAuthoredV2ManagerOptions(
    value.options,
    demoData?.products ?? [],
    ["supplier", "internal"],
  );
  const authoredBoundaryReply = replyWithAuthoredLead(
    boundaryReply,
    envelope.reply,
    demoData?.products ?? [],
    5,
    { requireCalibration: true },
  );
  const boundaryAction = safeBoundaryAction(
    value.reply?.body,
    demoData?.products ?? [],
  );
  const safeBoundaryReply =
    boundaryAction && !authoredBoundaryReply.body.includes(boundaryAction)
      ? {
          ...authoredBoundaryReply,
          body: `${authoredBoundaryReply.body}\n\n${boundaryAction}`,
        }
      : authoredBoundaryReply;
  return {
    ...base,
    zone: "red",
    decision: "escalate",
    route: "manager",
    commitment: "none",
    estimates: [],
    product: null,
    market: v2EmptyMarket(),
    zoneReason:
      "Точный товар или коммерческий объём не прошёл программную проверку.",
    managerNote:
      "Проверьте область применения и исходные данные; клиенту не обещаны цена или резерв.",
    options: completeManagerOptions(
      authoredOptions,
      v2BoundaryOptions(envelope),
    ),
    reply: safeBoundaryReply,
  };
}

function applyV2Envelope(result, envelope, demoData) {
  if (!envelope) {
    result.options = safeV2ManagerOptions(result.options);
    return result;
  }

  const { resolvedIntent } = envelope;
  const basis = groundedV2Basis(resolvedIntent);
  result.schemaVersion = 2;
  result.resolvedIntent = resolvedIntent;
  result.visionObservation = envelope.visionObservation;
  result.commitment = envelope.commitment;
  result.estimates = envelope.estimates;
  result.supplierLeads = envelope.supplierLeads;
  if (!envelope.hasGroundedProduct) {
    result.product = null;
    delete result.calculation;
    delete result.supplierPlan;
  }
  result.understood = resolvedIntent.evidence
    .filter((item) => !isNeutralOpenedEvidence(item))
    .map((item) => item.claim)
    .slice(0, 8);
  result.decisionBasis = basis;
  result.sources = v2Sources(resolvedIntent);
  if (envelope.research.sources.length) result.research = envelope.research;

  if (resolvedIntent.target.state === "ambiguous") {
    const question = resolvedIntent.blocker.question;
    result.zone = "yellow";
    result.decision = "clarify";
    result.route = "needs_info";
    result.commitment = "none";
    result.missing = [question];
    result.product = null;
    delete result.calculation;
    delete result.supplierPlan;
    result.estimates = [];
    result.supplierLeads = [];
    result.options = [];
    result.reply = ambiguityReply(question, resolvedIntent.blocker.choices);
    result.zoneReason =
      "На фото одинаково правдоподобны несколько объектов действия.";
    result.managerNote =
      "Ответ клиента выберет объект; остальные факты заказа сохранятся.";
    return result;
  }

  result.missing = [];
  if (envelope.commitment === "estimate") {
    result.zone = "yellow";
    result.decision = "clarify";
    result.route = "ready";
    if (!result.product?.requestedKg) result.product = null;
    result.options = [];
    result.reply = rangeEstimateReply(
      envelope.estimates,
      resolvedIntent.target.label,
      demoData,
    );
    return result;
  }

  if (
    envelope.commitment === "commercial_offer" &&
    result.product?.requestedKg > 0
  ) {
    if (result.zone === "red") {
      result.route = "manager";
      result.decision = "escalate";
      result.options = safeV2ManagerOptions(result.options);
    } else {
      result.zone = "green";
      result.decision = "quote";
      result.route = "ready";
      result.options = [];
      if (envelope.reply.subject && envelope.reply.body) {
        result.reply = replyWithAuthoredLead(
          result.reply,
          envelope.reply,
          demoData?.products ?? [],
        );
      }
    }
    return result;
  }

  result.zone = "red";
  result.decision = "escalate";
  result.route = "manager";
  result.commitment = "none";
  result.options =
    result.options.length >= 2
      ? safeV2ManagerOptions(result.options)
      : v2BoundaryOptions(envelope);
  result.reply =
    envelope.reply.subject &&
    envelope.reply.body &&
    !mentionedProduct(envelope.reply.body, demoData.products)
      ? envelope.reply
      : {
          subject: "Проверка предложения",
          body: "Руководитель получил безопасные варианты проверки.",
        };
  return result;
}

function orderText(job) {
  let conversation = job?.conversation;
  if (!Array.isArray(conversation) && typeof job?.conversationJson === "string") {
    try {
      conversation = JSON.parse(job.conversationJson);
    } catch {
      conversation = [];
    }
  }
  const customerReplies = Array.isArray(conversation)
    ? conversation
        .filter((message) => message?.role === "customer")
        .map((message) => text(message?.body))
        .filter(Boolean)
        .map((body, index) => `Ответ клиента ${index + 1}: ${body}`)
        .join("\n")
    : "";
  return `${job?.subject ?? ""} ${job?.body ?? ""} ${customerReplies}`.trim();
}

function productHasRequestedColor(product, requestText) {
  const requested = colorLabelFromText(requestText);
  if (!requested) return false;

  const available = product.colors.join(" ").toLocaleLowerCase("ru-RU");
  const ral = requested.match(/\bRAL\s*\d{4}\b/iu)?.[0].toUpperCase();
  if (ral) return available.includes(ral.toLocaleLowerCase("ru-RU"));

  const color = requested.split(",")[0].toLocaleLowerCase("ru-RU");
  const knownRal = {
    "тёмно-серый": ["ral 7024"],
    "светло-серый": ["ral 7035"],
    серый: ["ral 7024", "ral 7035"],
    чёрный: ["ral 9005"],
    белый: ["ral 9016"],
  };
  const stem = color.replace(/(?:ый|ая|ое|ые)$/u, "");
  return (
    available.includes(stem) ||
    (knownRal[color] ?? []).some((item) => available.includes(item))
  );
}

function orderLogisticsLine(value) {
  const sentence = String(value ?? "")
    .split(/[.!?\n]+/u)
    .map((item) => item.trim())
    .find((item) =>
      /достав|поставк|отгруз|забер|самовывоз/iu.test(item),
    );
  if (!sentence) return "";

  const normalized = sentence
    .replace(/\s+/g, " ")
    .replace(/^забер[её]м\b/iu, "вы заберёте")
    .replace(/^готовы\s+забрать\b/iu, "вы готовы забрать");
  return `${normalized.charAt(0).toLocaleLowerCase("ru-RU")}${normalized.slice(1)}`;
}

function orderAttachment(job) {
  if (job?.attachment && typeof job.attachment === "object") {
    return job.attachment;
  }
  if (typeof job?.attachmentJson !== "string" || !job.attachmentJson.trim()) {
    return null;
  }
  try {
    const attachment = JSON.parse(job.attachmentJson);
    return attachment && typeof attachment === "object" ? attachment : null;
  } catch {
    return null;
  }
}

function hasOrderAttachment(job) {
  const attachment = orderAttachment(job);
  return Boolean(
    attachment &&
      !Array.isArray(attachment) &&
      typeof attachment.src === "string" &&
      attachment.src.startsWith("/"),
  );
}

function orderFacts(job, demoData) {
  const sourceOrderText = orderText(job);
  const explicitSku = explicitSkuFromText(sourceOrderText);
  const matchedProduct = matchProduct(sourceOrderText, demoData.products);
  const deliveryPlan = deliveryPlanFromText(sourceOrderText);
  const requestedKg = deliveryPlan.totalKg;
  const parsedOrderFacts = orderFactsFromText(sourceOrderText);
  const floorUse = floorUseFactsFromText(sourceOrderText);
  const fence = parsedOrderFacts.fence;
  const hasWall =
    /(?:^|[^\p{L}])стен\p{L}*(?:[^\p{L}]|$)/iu.test(sourceOrderText);
  const hasFloor =
    /(?:^|[^\p{L}])пол(?:а|у|ом|ы|ов|е)?(?:[^\p{L}]|$)/iu.test(
      sourceOrderText,
    );
  const surfaceKind = hasWall === hasFloor ? "" : hasWall ? "wall" : "floor";
  const areaMatch = sourceOrderText.match(
    /(\d+(?:[.,]\d+)?)\s*(?:м\s*[²2]|кв(?:адратн\p{L}*)?\.?\s*м(?:етр\p{L}*)?|квадратн\p{L}*\s+метр\p{L}*)/iu,
  );
  const areaM2 = areaMatch
    ? Number(areaMatch[1].replace(",", "."))
    : 0;
  const surfaceMaterial =
    surfaceKind === "wall"
      ? /гипсокартон|(?:^|[^\p{L}])гкл(?:[^\p{L}]|$)/iu.test(sourceOrderText)
        ? "гипсокартон"
        : /штукатур/iu.test(sourceOrderText)
          ? "штукатурка"
          : /бетон/iu.test(sourceOrderText)
            ? "бетон"
            : ""
      : surfaceKind === "floor" &&
          /бетон|стяжк|цемент/iu.test(sourceOrderText)
        ? "бетон"
        : "";
  const surface =
    !fence && surfaceKind
      ? {
          kind: surfaceKind,
          material: surfaceMaterial,
          areaM2:
            Number.isFinite(areaM2) && areaM2 > 0 ? areaM2 : 0,
        }
      : null;
  const gaps = [];

  if (fence) {
    if (fence.material === "неясно") gaps.push("материал забора");
    if (!fence.areaPerSideM2) gaps.push("длина и высота забора");
    if (!fence.sides) gaps.push("стороны покраски");
    if (!hasColor(sourceOrderText)) gaps.push("желаемый цвет");
  } else if (surface && !requestedKg) {
    if (!surface.material) {
      gaps.push(
        surface.kind === "wall" ? "материал стены" : "материал пола",
      );
    }
    if (!surface.areaM2) {
      gaps.push(
        surface.kind === "wall" ? "площадь стен" : "площадь пола",
      );
    }
  } else if (!matchedProduct) {
    gaps.push(
      explicitSku
        ? `сверьте код ${explicitSku} с каталогом`
        : "опишите, что будете красить",
    );
  }

  if (!fence) {
    if (!requestedKg && !surface) gaps.push("объём в килограммах");
    if (!hasUsableEnvironment(sourceOrderText)) {
      gaps.push("где будут красить: на улице или в помещении");
    }
    if (!hasColor(sourceOrderText)) {
      gaps.push("цвет или номер RAL");
    }
    if (asksCompatibility(sourceOrderText)) {
      if (surface?.kind === "floor") {
        if (!floorUse.purpose) gaps.push("назначение помещения");
        if (!floorUse.cleaning) gaps.push("способ уборки");
        if (!floorUse.load) gaps.push("нагрузка на пол");
      } else {
        gaps.push("как будут пользоваться окрашенной поверхностью");
      }
    }
  }

  if (
    /(?:фото|фотограф|снимок|прикреп\p{L}*)/iu.test(sourceOrderText) &&
    !hasOrderAttachment(job)
  ) {
    gaps.push("приложите фотографию");
  }

  return {
    sourceOrderText,
    explicitSku,
    matchedProduct,
    requestedKg,
    firstDeliveryKg: deliveryPlan.firstDeliveryKg,
    color: colorLabelFromText(sourceOrderText),
    inn: parsedOrderFacts.inn,
    fence,
    surface,
    floorUse,
    gaps,
  };
}

function hasCommercialBoundary(facts) {
  const product = facts.matchedProduct;
  const priceBelowProfit =
    product &&
    quotedUnitPrices(facts.sourceOrderText).some(
      (price) => price < product.minPricePerKg,
    );

  return Boolean(
    hasSpecialTerms(facts.sourceOrderText) ||
      (facts.explicitSku && !product) ||
      (product &&
        facts.requestedKg > 0 &&
        facts.requestedKg > product.stockKg) ||
      priceBelowProfit,
  );
}

function companyResearchMatch(job, facts) {
  if (facts.inn) return "exact";
  const website = text(job?.website);
  if (website) {
    try {
      const url = new URL(
        website.includes("://") ? website : `https://${website}`,
      );
      const host = url.hostname.toLowerCase();
      if (
        host &&
        !host.endsWith(".example") &&
        host !== "example.com" &&
        host !== "www.example.com"
      ) {
        return "exact";
      }
    } catch {
      // A company name can still support a cautious search.
    }
  }
  return cleanSourceText(job?.company) ? "name" : "";
}

function comparableHost(value) {
  const source = text(value);
  if (!source) return "";
  try {
    return new URL(source.includes("://") ? source : `https://${source}`)
      .hostname.toLowerCase()
      .replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function preparedProfileForJob(job, facts, demoData) {
  const profiles = Array.isArray(demoData?.companyProfiles)
    ? demoData.companyProfiles
    : [];
  if (facts.inn) {
    const byInn = profiles.find(
      (profile) => text(profile?.inn) === facts.inn,
    );
    if (byInn) return byInn;
  }

  const host = comparableHost(job?.website);
  return host
    ? profiles.find(
        (profile) => comparableHost(profile?.website) === host,
      ) ?? null
    : null;
}

function preparedResearchFor(profile) {
  if (!profile) return null;
  const rawSources = Array.isArray(profile.sources) ? profile.sources : [];
  const sources = rawSources
    .map((source) => ({
      title: cleanCopy(source?.title).slice(0, 180),
      url: canonicalPublicHttpsUrl(source?.url),
      checkedAt: cleanSourceText(source?.checkedAt, 40),
      fact: cleanCopy(source?.fact).slice(0, 420),
    }))
    .filter(
      (source) =>
        source.title && source.url && source.checkedAt && source.fact,
    )
    .slice(0, 3);
  if (!sources.length || sources.length !== Math.min(rawSources.length, 3)) {
    return null;
  }
  return {
    checked: true,
    summary: `${cleanCopy(profile.summary)} Источники заранее проверены для демонстрации.`,
    sources,
  };
}

function fenceCalculation(facts, demoData) {
  const fence = facts.fence;
  const product = facts.matchedProduct;
  if (
    !fence ||
    !product ||
    fence.material === "неясно" ||
    !fence.areaPerSideM2 ||
    !fence.sides
  ) {
    return undefined;
  }

  const paintAreaM2 = fence.areaPerSideM2 * fence.sides;
  const coverageKgPerM2PerCoat = Number(product.coverageKgPerM2PerCoat);
  const coats = Number(product.recommendedCoats);
  const reservePercent = Number(
    demoData.rules?.calculationReservePercent ?? 10,
  );
  const packageKg = Number(product.packKg);
  if (
    !Number.isFinite(coverageKgPerM2PerCoat) ||
    coverageKgPerM2PerCoat <= 0 ||
    !Number.isFinite(coats) ||
    coats <= 0 ||
    !Number.isFinite(packageKg) ||
    packageKg <= 0
  ) {
    return undefined;
  }

  const estimatedKg =
    paintAreaM2 *
    coverageKgPerM2PerCoat *
    coats *
    (1 + reservePercent / 100);
  const packages = Math.ceil(estimatedKg / packageKg);
  const roundedKg = packages * packageKg;

  return {
    kind: "fence-area",
    material: fence.material,
    lengthM: fence.lengthM,
    heightM: fence.heightM,
    areaPerSideM2: fence.areaPerSideM2,
    sides: fence.sides,
    paintAreaM2,
    coverageKgPerM2PerCoat,
    coats,
    reservePercent,
    estimatedKg,
    packageKg,
    packages,
    roundedKg,
    explanation: `${decimal.format(
      paintAreaM2,
    )} м² × ${coats} слоя × ${decimal.format(
      coverageKgPerM2PerCoat,
    )} кг/м² + ${decimal.format(
      reservePercent,
    )}% запаса = ${decimal.format(
      estimatedKg,
    )} кг. Берём ${packages} ${countedNoun(
      packages,
      "упаковку",
      "упаковки",
      "упаковок",
    )} по ${decimal.format(packageKg)} кг: ${decimal.format(roundedKg)} кг.`,
  };
}

function surfaceCalculation(facts, demoData) {
  const surface = facts.surface;
  const product = facts.matchedProduct;
  if (
    !surface ||
    !product ||
    !surface.material ||
    !surface.areaM2 ||
    facts.requestedKg > 0 ||
    !Array.isArray(product.substrates) ||
    !product.substrates.includes(surface.material)
  ) {
    return undefined;
  }

  const coverageKgPerM2PerCoat = Number(product.coverageKgPerM2PerCoat);
  const coats = Number(product.recommendedCoats);
  const reservePercent = Number(
    demoData.rules?.calculationReservePercent ?? 10,
  );
  const packageKg = Number(product.packKg);
  if (
    ![coverageKgPerM2PerCoat, coats, reservePercent, packageKg].every(
      Number.isFinite,
    ) ||
    coverageKgPerM2PerCoat <= 0 ||
    coats <= 0 ||
    reservePercent < 0 ||
    packageKg <= 0
  ) {
    return undefined;
  }

  const estimatedKg =
    surface.areaM2 *
    coverageKgPerM2PerCoat *
    coats *
    (1 + reservePercent / 100);
  const packages = Math.ceil(estimatedKg / packageKg);
  const roundedKg = packages * packageKg;
  const surfaceLabel = surface.kind === "wall" ? "стена" : "пол";

  return {
    kind: surface.kind === "wall" ? "wall-area" : "floor-area",
    surface: surfaceLabel,
    material: surface.material,
    source: "письмо клиента",
    lengthM: null,
    heightM: null,
    areaPerSideM2: surface.areaM2,
    sides: 1,
    paintAreaM2: surface.areaM2,
    coverageKgPerM2PerCoat,
    coats,
    reservePercent,
    estimatedKg: Number(estimatedKg.toFixed(2)),
    packageKg,
    packages,
    roundedKg,
    explanation: `${decimal.format(surface.areaM2)} м² × ${coats} слоя × ${decimal.format(
      coverageKgPerM2PerCoat,
    )} кг/м² + ${decimal.format(
      reservePercent,
    )}% запаса = ${decimal.format(
      estimatedKg,
    )} кг. Берём ${packages} ${countedNoun(
      packages,
      "упаковку",
      "упаковки",
      "упаковок",
    )} по ${decimal.format(packageKg)} кг: ${decimal.format(roundedKg)} кг.`,
  };
}

function groundedUnderstanding(job, facts) {
  const company = cleanSourceText(job?.company);
  const hasAttachment = hasOrderAttachment(job);
  const understood = [
    company ? `Компания из заявки: ${company}` : "",
    facts.fence ? "Задача клиента: покрасить забор" : "",
    facts.surface?.kind === "floor" ? "Задача клиента: покрасить пол" : "",
    facts.fence && hasAttachment ? "Фотография приложена к заявке" : "",
    facts.fence && facts.fence.material !== "неясно"
      ? `Материал забора: ${facts.fence.material}`
      : "",
    facts.matchedProduct
      ? `Краска по каталогу: ${facts.matchedProduct.name}`
      : "",
    facts.fence?.paintAreaM2
      ? `Площадь покраски: ${decimal.format(facts.fence.paintAreaM2)} м²`
      : "",
    facts.surface?.areaM2
      ? `Площадь пола: ${decimal.format(facts.surface.areaM2)} м²`
      : "",
    facts.floorUse?.material
      ? `Материал пола: ${facts.floorUse.material}`
      : "",
    facts.floorUse?.purpose
      ? `Назначение помещения: ${facts.floorUse.purpose}`
      : "",
    facts.floorUse?.cleaning
      ? `Уборка: ${facts.floorUse.cleaning}`
      : "",
    facts.floorUse?.load ? `Нагрузка: ${facts.floorUse.load}` : "",
    facts.requestedKg
      ? `Объём из письма: ${money.format(facts.requestedKg)} кг`
      : "",
  ].filter(Boolean);
  return understood.length
    ? understood
    : ["Добавьте детали заказа — агент сразу начнёт расчёт."];
}

function industryFor(job, demoData) {
  const source = `${orderText(job)} ${job?.company ?? ""}`.toLowerCase();
  if (/(машиностро|волгамаш|завод|машин|оборудован)/.test(source)) {
    return demoData.industries[1];
  }
  if (/(строит|строй|объект|подряд|девелоп|ремонт|офис)/.test(source)) {
    return demoData.industries[2];
  }
  if (/(склад|логистическ|терминал|покрыти[ея]\s+пола)/.test(source)) {
    return demoData.industries[3];
  }
  if (/(металлоконструк|антикорроз|корроз)/.test(source)) {
    return demoData.industries[0];
  }
  return null;
}

function groundedBusinessContext({
  facts,
  industry,
  openedResearchSources,
}) {
  const researchFacts = openedResearchSources
    .map((source) => source.fact)
    .filter(Boolean);
  const product = facts.matchedProduct;
  const productLine = product
    ? `Каталог подтверждает для «${product.name}»: ${product.features.join(
        ", ",
      )}.`
    : "";
  const publicContext = researchFacts.join(" ");
  const companyAndOrder = `${publicContext} ${facts.sourceOrderText}`;
  const profileSuggestsRegulatedWarehouse =
    facts.surface?.kind === "floor" &&
    /фармацевт|медицин|лекарств|логистическ\p{L}*\s+(?:парк|склад)|мультитемпературн\p{L}*\s+хранени/iu.test(
      companyAndOrder,
    );
  const floorUseConfirmed = Boolean(
    facts.floorUse?.material &&
      facts.floorUse?.purpose &&
      facts.floorUse?.cleaning &&
      facts.floorUse?.load,
  );
  const hypothesis = profileSuggestsRegulatedWarehouse
    ? floorUseConfirmed
      ? `Клиент подтвердил бетонный пол, назначение «${facts.floorUse.purpose}», уборку «${facts.floorUse.cleaning}» и нагрузку «${facts.floorUse.load}». Каталог подтверждает КР-003 для бетонного пола внутри цехов и складов и для нагрузки от тележек и техники.`
      : "Агент предполагает, что краска нужна для склада компании, и проверит это одним вопросом. Для бетонного пола склада, по которому ездит техника, первым вариантом станет КР-003."
    : "";
  const needsCompatibilityDetails =
    asksCompatibility(facts.sourceOrderText) &&
    (facts.surface?.kind !== "floor" ||
      !facts.floorUse?.cleaning ||
      !facts.floorUse?.load);
  const asksSpecificProof =
    /ГОСТ|GMP|ISO|СанПиН|дезинф|дезсредств|химическ\p{L}*\s+стойк/iu.test(
      facts.sourceOrderText,
    );
  const compatibilityStep = needsCompatibilityDetails
    ? facts.surface?.kind === "floor"
      ? "Клиент сообщил о ежедневной уборке. Агент уточнит материал пола, назначение помещения, средство для уборки и нагрузку перед расчётом."
      : "Агент уточнит условия использования поверхности перед расчётом."
    : asksSpecificProof
      ? "Технолог проверит точное требование к документу или средству до предложения."
    : "";
  const quantityStep =
    product && !facts.requestedKg && !facts.surface
      ? "Письмо связано с каталогом. После ответа об объёме агент сверит остаток на момент расчёта и соберёт расчёт."
      : "";
  const industryLine =
    industry && !hypothesis
      ? `Для клиента важно: ${industry.risk}. Агент предлагает: ${industry.play}.`
      : "";

  return [
    publicContext,
    hypothesis,
    productLine,
    compatibilityStep,
    quantityStep,
    industryLine,
  ]
    .filter(Boolean)
    .join(" ");
}

function marketSnapshot(product, demoData, requestedKg) {
  const items = demoData.market
    .filter((item) => item.category === product.category)
    .map(
      ({
        competitor,
        pricePerKg,
        deliveryDays,
        checkedAt,
        stockKg,
        stockCheckedAt,
      }) => ({
      competitor,
      pricePerKg,
      deliveryDays,
      checkedAt,
        stockKg,
        stockCheckedAt,
      }),
    );

  const comparison = items
    .map(
      (item) =>
        `${item.competitor}: ${money.format(item.pricePerKg)} ₽/кг, срок ${
          item.deliveryDays
        } дн.`,
    )
    .join(" ");
  const marketAverage = items.length
    ? Math.round(
        items.reduce((sum, item) => sum + item.pricePerKg, 0) / items.length,
      )
    : 0;
  const marketMax = items.length
    ? Math.max(...items.map((item) => item.pricePerKg))
    : 0;
  const difference = product.pricePerKg - marketAverage;
  const marketReference =
    items.length === 1
      ? "цены другого поставщика"
      : "средней цены других поставщиков";
  const equalMarketReference =
    items.length === 1
      ? "с ценой другого поставщика"
      : "со средней ценой других поставщиков";
  const closeToAverage =
    marketAverage > 0 &&
    Math.abs(difference) <= Math.max(5, marketAverage * 0.02);
  const availability =
    requestedKg <= 0
      ? "Количество уточняем перед предложением."
      : requestedKg <= product.stockKg
        ? "Весь объём подтверждён складом."
        : `Склад подтверждает ${money.format(
            product.stockKg,
          )} из ${money.format(
            requestedKg,
          )} кг. Поставку оставшейся части согласует руководитель.`;
  const position =
    marketAverage === 0
      ? `Цена ${money.format(
          product.pricePerKg,
        )} ₽/кг взята из описания краски в каталоге. Завод зарабатывает при цене от ${money.format(
          product.minPricePerKg,
        )} ₽/кг.`
      : closeToAverage
        ? Math.round(Math.abs(difference)) === 0
          ? `Наша цена ${money.format(
              product.pricePerKg,
            )} ₽/кг совпадает ${equalMarketReference}. ${availability}`
          : `Наша цена ${money.format(product.pricePerKg)} ₽/кг, на ${money.format(
              Math.round(Math.abs(difference)),
            )} ₽ ${difference > 0 ? "выше" : "ниже"} ${marketReference}. ${
              difference > 0
                ? "Цена близка к рынку."
                : "Цена выглядит привлекательно."
            } ${availability}`
        : difference < 0
          ? `Наша цена ${money.format(
              product.pricePerKg,
            )} ₽/кг на ${money.format(
              Math.round(Math.abs(difference)),
            )} ₽ ниже ${marketReference}.`
          : `Наша цена ${money.format(
              product.pricePerKg,
            )} ₽/кг, на ${money.format(
              Math.round(difference),
            )} ₽ выше ${marketReference}. Агент покажет клиенту наличие, срок и свойства краски. ${availability}`;
  const priceRoom = marketMax - product.pricePerKg;
  const profitOpportunity =
    priceRoom > 0
      ? `На следующем похожем заказе можно проверить цену до ${money.format(
          marketMax,
        )} ₽/кг при сопоставимых свойствах, объёме и сроке. Журнал покажет результат.`
      : "Заработать больше поможет крупный заказ или удобный график поставки.";

  return {
    checked: true,
    summary: comparison
      ? `Цены других поставщиков. ${comparison} Цена «Колер»: ${money.format(
          product.pricePerKg,
        )} ₽/кг.`
      : `Цена ${money.format(
          product.pricePerKg,
        )} ₽/кг взята из описания краски в каталоге. Завод зарабатывает при цене от ${money.format(
          product.minPricePerKg,
        )} ₽/кг.`,
    items,
    position,
    profitOpportunity,
  };
}

function productCoversRequestedUse(product, requestText) {
  const features = Array.isArray(product?.features)
    ? product.features.join(" ")
    : "";
  if (!features) return false;
  if (/масл/iu.test(requestText)) return /масл/iu.test(features);
  if (/дезинф|дезсредств/iu.test(requestText)) {
    return /дезинф|дезсредств/iu.test(features);
  }
  if (/(?:ГОСТ|GMP|ISO|СанПиН)/u.test(requestText)) {
    const requested = requestText.match(
      /(?:ГОСТ|GMP|ISO|СанПиН)[\s№:.-]*[\dА-ЯA-Z-]*/u,
    )?.[0];
    return Boolean(requested && features.includes(requested));
  }
  if (/нейтральн\p{L}*\s+(?:моющ\p{L}*\s+)?средств/iu.test(requestText)) {
    return /ежедневн\p{L}*[^.]{0,80}нейтральн\p{L}*\s+(?:моющ\p{L}*\s+)?средств/iu.test(
      features,
    );
  }
  if (/влажн\p{L}*\s+уборк/iu.test(requestText)) {
    return /влажн\p{L}*\s+уборк/iu.test(features);
  }
  return false;
}

function technicalReviewSummary(requestText) {
  if (/масл/iu.test(requestText)) {
    return "Клиент сообщил о регулярном контакте пола с моторным маслом. Агент собрал условия, расчёт и описание краски из каталога; технолог проверит стойкость на образце и закрепит подходящее покрытие.";
  }
  if (/дезинф|дезсредств/iu.test(requestText)) {
    return "Клиент использует дезинфицирующее средство. Агент передаст технологу название средства, режим уборки, расчёт и описание краски из каталога для точного подтверждения.";
  }
  return "Клиент указал обязательный документ. Агент передаст технологу точное требование, описание краски из каталога и готовый расчёт для проверки комплекта поставки.";
}

function technicalReviewOptions(product, requestedKg, requestText) {
  if (/масл/iu.test(requestText)) {
    return [
      {
        id: "проверка-образца",
        title: "Проверить покрытие на образце",
        rationale:
          "Технолог получает образец вещества, условия уборки и нагрузку на пол.",
        tradeoff: "Понадобится образец и короткая проверка технолога.",
        reply: `Для бетонного пола и движения тележек первым вариантом стала краска «${product.name}». Контакт с моторным маслом технолог проверит на образце. Предварительный расчёт — ${money.format(
          requestedKg,
        )} кг. После проверки направим подтверждённое покрытие, цену и график поставки.`,
      },
      {
        id: "пробный-участок",
        title: "Сделать пробное нанесение",
        rationale:
          "Небольшой участок покажет поведение покрытия в условиях мастерской.",
        tradeoff: "Основная закупка начнётся после осмотра пробного участка.",
        reply: `Предлагаем сначала окрасить небольшой участок пола краской «${product.name}». На основную площадь предварительно рассчитано ${money.format(
          requestedKg,
        )} кг. После осмотра закрепим состав и график поставки.`,
      },
      {
        id: "подбор-технолога",
        title: "Подобрать покрытие под масло",
        rationale:
          "Технолог сверит частоту контакта, способ удаления масла и нагрузку.",
        tradeoff: "Клиент уточнит вид масла и способ уборки.",
        reply:
          "Технолог подберёт покрытие под контакт с моторным маслом. Пришлите название масла и опишите, как быстро его удаляют с пола. Остальные условия уже сохранены в заказе.",
      },
    ];
  }

  return [
    {
      id: "сверить-требование",
      title: "Сверить точное требование",
      rationale:
        "Технолог сопоставит название документа или средства с паспортом качества и описанием краски в каталоге.",
      tradeoff: "Клиент пришлёт точное название документа или средства.",
      reply:
        "Пришлите точное название обязательного документа или средства для уборки. Технолог сверит требование с паспортом качества и описанием краски в каталоге, затем мы направим подтверждённое предложение.",
    },
    {
      id: "проверка-технолога",
      title: "Провести проверку технолога",
      rationale:
        "Технолог проверит режим эксплуатации по образцу и закрепит подходящее покрытие.",
      tradeoff: "Понадобится образец и время на проверку.",
      reply: `Технолог проверит покрытие для ваших условий. Площадь, бетонное основание, уборку и предварительный расчёт ${money.format(
        requestedKg,
      )} кг уже сохранены. После проверки направим состав, документы и график поставки.`,
    },
    {
      id: "подобрать-покрытие",
      title: "Подобрать покрытие по требованиям",
      rationale:
        "Технолог начинает с обязательного документа и режима уборки.",
      tradeoff: "Подбор продолжится после одного ответа клиента.",
      reply:
        "Напишите обязательный документ и средство для уборки. Технолог подберёт покрытие по этим требованиям. Остальные сведения о помещении и расчёт уже сохранены.",
    },
  ];
}

function optionIsSafe(option) {
  if (!option || typeof option !== "object") return false;
  return (
    !isAllCapsHeading(option.title) &&
    ["title", "rationale", "tradeoff"].every((key) =>
      Boolean(cleanCopy(option[key])),
    ) && Boolean(cleanClientCopy(option.reply))
  );
}

function mentionedProduct(value, products) {
  const source = text(value).toLowerCase();
  return products.find(
    (product) =>
      source.includes(product.sku.toLowerCase()) ||
      source.includes(product.name.toLowerCase()),
  );
}

function optionCopy(option) {
  return [
    option?.title,
    option?.rationale,
    option?.tradeoff,
    option?.reply,
  ]
    .map(text)
    .join(" ");
}

function targetProductForOption(option, product, demoData) {
  return (
    mentionedProduct(option?.reply, demoData.products) ??
    mentionedProduct(optionCopy(option), demoData.products) ??
    product
  );
}

function offersUnapprovedAnalogue(option, product, demoData) {
  const copy = optionCopy(option).toLowerCase();
  const approvedSkus = new Set([product.sku, ...product.analogues]);
  const mentionedSkus = [
    ...copy.matchAll(/кр-\d{1,4}/gi),
  ].map((match) => match[0].toUpperCase());
  if (mentionedSkus.some((sku) => !approvedSkus.has(sku))) return true;

  return demoData.products.some(
    (candidate) =>
      candidate.sku !== product.sku &&
      !product.analogues.includes(candidate.sku) &&
      (copy.includes(candidate.sku.toLowerCase()) ||
        copy.includes(candidate.name.toLowerCase())),
  );
}

function offersUnavailableColor(
  option,
  product,
  requestText,
  demoData,
) {
  const targetProduct = targetProductForOption(option, product, demoData);
  return (
    targetProduct.sku !== product.sku &&
    !productHasRequestedColor(targetProduct, requestText)
  );
}

function promisesUnavailableFullVolume(
  option,
  product,
  requestedKg,
  demoData,
) {
  if (requestedKg <= 0) return false;
  const reply = text(option?.reply);
  const promisesDelivery =
    /(подтвержд\w*|в\s+наличии|есть\s+на\s+складе|доступн\w*|отгруз\w*|постав\w*|достав\w*|закро\w*|обеспеч\w*|зарезервир\w*|можем\s+(?:предложить|поставить|отгрузить|закрыть)|готовы\s+(?:предложить|поставить|отгрузить|закрыть))/i.test(
      reply,
    );
  if (!promisesDelivery) return false;

  const targetProduct = targetProductForOption(
    option,
    product,
    demoData,
  );
  const promisesFullVolume =
    /(?:полный|весь)\s+объ[её]м/i.test(reply) ||
    quantityFromText(reply) >= requestedKg;

  return promisesFullVolume && targetProduct.stockKg < requestedKg;
}

function quotesBelowMinimum(option, product, demoData) {
  const reply = text(option?.reply);
  const targetProduct = targetProductForOption(
    option,
    product,
    demoData,
  );
  return quotedUnitPrices(reply).some(
    (price) => price < targetProduct.minPricePerKg,
  );
}

function fallbackOptions(
  product,
  requestedKg,
  demoData,
  allowAlternative = true,
  requestText = "",
  requestedFirstDeliveryKg = 0,
) {
  const availableKg = Math.min(product.stockKg, requestedKg);
  const missingKg = Math.max(0, requestedKg - availableKg);
  const firstDeliveryKg = Math.min(
    requestedFirstDeliveryKg || availableKg,
    availableKg,
  );
  const nextDeliveryKg = Math.max(0, requestedKg - firstDeliveryKg);

  if (missingKg === 0) {
    return [
      {
        id: "standard",
        title: "Предложить обычную цену и срок",
        rationale:
          "Подтвердить наличие и цену, предложить обычный срок оплаты и поставки.",
        tradeoff: "Клиент сразу увидит действующие условия.",
        reply: `Подтверждаем наличие ${money.format(
          requestedKg,
        )} кг краски «${product.name}» по цене ${money.format(
          product.pricePerKg,
        )} ₽/кг. Готовы согласовать поставку на обычных условиях.`,
      },
      {
        id: "volume",
        title: "Дать лучшую цену за план закупок",
        rationale:
          "Клиент заранее согласует объём на квартал и вносит предоплату.",
        tradeoff:
          "Руководитель увидит план закупок и выберет цену.",
        reply: `Готовы обсудить лучшую цену, если согласуем закупки на квартал и предоплату. Текущая цена составляет ${money.format(
          product.pricePerKg,
        )} ₽/кг.`,
      },
      {
        id: "clarify",
        title: "Спросить, что важнее клиенту",
        rationale:
          "Уточнить, что важнее: срок, цена или порядок оплаты.",
        tradeoff: "Расчёт продолжится после одного короткого ответа.",
        reply:
          "Что для вас важнее: срок, цена или порядок оплаты? По ответу подготовим подходящий вариант.",
      },
    ];
  }

  const alternative = demoData.products.find(
    (candidate) =>
      product.analogues.includes(candidate.sku) &&
      candidate.stockKg >= requestedKg &&
      productHasRequestedColor(candidate, requestText),
  );
  const supplierPlan = buildSupplierPlan(
    product,
    demoData.market,
    requestedKg,
  );
  const supplierDaysSaved = supplierPlan
    ? Math.max(0, product.replenishmentDays - supplierPlan.deliveryDays)
    : 0;
  const supplierSaving = supplierPlan
    ? Math.max(0, product.pricePerKg * requestedKg - supplierPlan.total)
    : 0;
  const requestedColor = colorLabelFromText(requestText);

  const options = [
    {
      id: "две-поставки",
      title: "Разделить поставку",
      rationale: `Отгрузить ${money.format(
        firstDeliveryKg,
      )} кг из наличия и поставить ${money.format(
        nextDeliveryKg,
      )} кг после пополнения через ${product.replenishmentDays} дней.`,
      tradeoff:
        "Клиент запускает работу с первой партией и заранее получает график второй.",
      reply: `Предлагаем разделить поставку: ${money.format(
        firstDeliveryKg,
      )} кг отгрузим из наличия, ещё ${money.format(
        nextDeliveryKg,
      )} кг поставим после пополнения склада через ${
        product.replenishmentDays
      } дней. Цена составляет ${money.format(product.pricePerKg)} ₽/кг.`,
    },
  ];

  if (supplierPlan) {
    options.push({
      id: "помочь-с-недостающим-объёмом",
      title: `Собрать ${money.format(
        requestedKg,
      )} кг вместе с «${supplierPlan.supplierName}»`,
      rationale: `После подтверждения партнёра клиент сможет получить все ${money.format(
        requestedKg,
      )} кг ориентировочно за ${supplierPlan.deliveryDays} ${countedNoun(
        supplierPlan.deliveryDays,
        "день",
        "дня",
        "дней",
      )}${
        supplierDaysSaved
          ? ` — на ${money.format(supplierDaysSaved)} ${countedNoun(
              supplierDaysSaved,
              "день",
              "дня",
              "дней",
            )} раньше`
          : ""
      }. Общая стоимость — ${money.format(supplierPlan.total)} ₽${
        supplierSaving
          ? `, на ${money.format(
              supplierSaving,
            )} ₽ меньше расчёта по цене «Колера»`
          : ""
      }.`,
      businessResult:
        "Завод продаёт свою часть, координирует общий график и помогает клиенту начать работу раньше.",
      tradeoff:
        "На каждом участке нужна краска одного производителя. Технолог сверит подготовку пола, цвет и совместимость материалов.",
      reply: `Добрый день!\n\nНа складе «Колера» доступно ${money.format(
        supplierPlan.ourKg,
      )} кг по ${money.format(
        supplierPlan.ourPricePerKg,
      )} ₽/кг. По данным от ${
        supplierPlan.stockCheckedAt
      } у «${supplierPlan.supplierName}» доступно ${money.format(
        supplierPlan.supplierStockKg,
      )} кг. Готовим запрос партнёру: подтвердить ${money.format(
        supplierPlan.supplierKg,
      )} кг; срок — ${supplierPlan.deliveryDays} ${countedNoun(
        supplierPlan.deliveryDays,
        "день",
        "дня",
        "дней",
      )}; ${requestedColor ? `цвет — «${requestedColor}»` : "цвет"}; совместимость материалов. Цена партнёра по проверенной строке — ${money.format(
        supplierPlan.supplierPricePerKg,
      )} ₽/кг; предварительная стоимость обеих частей — ${money.format(
        supplierPlan.total,
      )} ₽.${
        supplierDaysSaved
          ? `\n\nПосле подтверждения этот вариант может сократить ожидание на ${money.format(
              supplierDaysSaved,
            )} ${countedNoun(
              supplierDaysSaved,
              "день",
              "дня",
              "дней",
            )}${supplierSaving ? ` и сэкономить ${money.format(supplierSaving)} ₽` : ""} относительно расчёта всего объёма по цене «Колера».`
          : ""
      }\n\nПосле подтверждений пришлём единый график поставки.`,
    });
  }

  if (allowAlternative && alternative) {
    options.push({
      id: "alternative",
      title: `Предложить ${alternative.name}`,
      rationale: `${money.format(
        alternative.stockKg,
      )} кг есть на складе. Эта краска подходит для задачи клиента.`,
      tradeoff: `Цена составляет ${money.format(
        alternative.pricePerKg,
      )} ₽/кг. В письме прямо указана выбранная замена.`,
      reply: `Можем предложить ${alternative.name} из наличия в полном объёме. Цена составляет ${money.format(
        alternative.pricePerKg,
      )} ₽/кг. Эта краска подходит для вашей задачи.`,
    });
  }

  options.push({
    id: "contract",
    title: "Добавить краску в ближайший выпуск",
    rationale: `Добавить недостающие ${money.format(
      missingKg,
    )} кг в ближайшем выпуске.`,
    tradeoff:
      "Производство подтвердит срок, руководитель закрепит условия до отправки письма.",
    reply: `Готовы добавить недостающие ${money.format(
      missingKg,
    )} кг в ближайшем выпуске. После подтверждения заказа закрепим цену и направим точный график поставки.`,
  });

  options.push({
    id: "clarify",
    title: "Уточнить нужный график",
    rationale:
      "Получить от клиента минимальный объём первой партии и крайний срок второй.",
    tradeoff: "Расчёт продолжится после одного короткого ответа.",
    reply:
      "Уточните минимальный объём первой партии и крайний срок второй. По ответу сразу закрепим выполнимый график.",
  });

  return options.slice(0, 3);
}

function fallbackReply(result, job, demoData, facts) {
  const safeJobSubject = cleanCopy(job?.subject);
  const subject = `Предложение по заказу: ${safeJobSubject || "краска"}`;

  if (result.zone === "yellow") {
    const questionFor = (item) =>
      ({
        "материал забора":
          "Из чего сделан забор: из дерева, металла или другого материала?",
        "длина и высота забора":
          "Напишите длину и среднюю высоту забора. Можно указать готовую площадь.",
        "стороны покраски": "Красим одну сторону забора или обе?",
        "желаемый цвет": "Какой цвет хотите получить?",
        "объём в килограммах": "Сколько килограммов краски нужно?",
        "где будут красить: на улице или в помещении":
          "Где будете красить: на улице или в помещении?",
        "цвет или номер RAL":
          "Какой цвет нужен? Можно описать его словами или указать номер из каталога цветов RAL.",
        "приложите фотографию":
          "Приложите фотографию, которую упомянули в письме.",
      })[item] ?? item;
    const questions = result.missing.length
      ? result.missing.length === 1 &&
        /^Подскажите, пожалуйста:/iu.test(result.missing[0])
        ? result.missing[0]
        : result.missing.map((item) => `— ${questionFor(item)}`).join("\n")
      : "— что будете красить\n— сколько краски нужно\n— улица или помещение";
    const sourceProduct = result.product
      ? demoData?.products?.find(
          (product) => product.sku === result.product.sku,
        )
      : null;
    const researchedFloor =
      sourceProduct?.sku === "КР-003" &&
      result.research?.checked &&
      /фармацевт|медицин|лекарств|мультитемпературн|логистическ\p{L}*\s+(?:парк|склад)/iu.test(
        result.businessContext,
      );
    if (researchedFloor) {
      const requestedColor = colorLabelFromText(orderText(job));
      const colorLine =
        requestedColor &&
        Array.isArray(sourceProduct.colors) &&
        sourceProduct.colors.some(
          (color) =>
            text(color).toLocaleLowerCase("ru-RU") ===
            requestedColor.toLocaleLowerCase("ru-RU"),
        )
          ? `Запрошенный цвет «${requestedColor}» есть в каталоге.`
          : requestedColor
            ? `Учли запрошенный цвет «${requestedColor}».`
            : "";
      const documentRequest =
        /ГОСТ|GMP|ISO|СанПиН|дезинф|дезсредств|химическ\p{L}*\s+стойк/iu.test(
          orderText(job),
        )
          ? "Пришлите точное требование к документу или средству — технолог проверит его до предложения."
          : "";
      return {
        subject: "Один вопрос для точного подбора краски",
        body: [
          "Добрый день!",
          [
            "Как используют помещение?",
            `Чтобы подобрать покрытие${
              facts?.surface?.areaM2
                ? ` для ${decimal.format(facts.surface.areaM2)} м²`
                : ""
            }, выберите ближайший вариант:`,
            "— медицинский склад: материал пола, средство для ежедневной уборки, техника на полу и нужные документы;",
            "— обычный склад: материал пола, уборка и техника;",
            "— другое помещение: назначение, материал пола, уборка и нагрузка.",
          ].join("\n"),
          "На сайте группы описаны фармацевтические и медицинские направления и складской комплекс. Похоже, помещение может быть складом.",
          `Если его используют как медицинский склад, пол бетонный, его моют нейтральным средством и по нему ездят тележки, первым вариантом станет краска «${sourceProduct.name}». Описание краски в каталоге подтверждает такую уборку, нагрузку от техники и паспорт качества на партию.`,
          colorLine,
          documentRequest,
          "Если помещение используют иначе, подберём покрытие по назначению, нагрузке и условиям уборки.",
          facts?.surface?.areaM2
            ? `После ответа рассчитаем заказ на ${decimal.format(
                facts.surface.areaM2,
              )} м², проверим цвет и свежий остаток на складе.`
            : "После ответа рассчитаем количество краски и проверим остаток на складе.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    return {
      subject: `Уточнение по заказу: ${safeJobSubject || "краска"}`,
      body: `Добрый день!\n\nЧтобы подготовить точное предложение, уточните:\n${questions}\n\nПосле ответа проверим наличие, цену и срок поставки.`,
    };
  }

  if (result.product) {
    const sourceOrderText = orderText(job);
    const color = colorLabelFromText(sourceOrderText);
    const logistics = orderLogisticsLine(sourceOrderText);
    const sourceProduct = demoData?.products?.find(
      (product) => product.sku === result.product.sku,
    );
    const floorFitLine =
      facts?.surface?.kind === "floor" &&
      facts.floorUse?.material === "бетон" &&
      facts.floorUse?.purpose &&
      facts.floorUse?.cleaning &&
      facts.floorUse?.load &&
      sourceProduct
        ? `Для вашей задачи выбрали эту краску по описанию в каталоге: она ${sourceProduct.features.join(
            ", ",
          )}.`
        : "";
    const nextStep = /забер|самовывоз/iu.test(logistics)
      ? "Подтвердите время самовывоза — подготовим заказ к выдаче."
      : "Пришлите точный адрес разгрузки — и мы запланируем отгрузку.";
    return {
      subject,
      body: [
        "Добрый день!",
        "",
        floorFitLine,
        `Подтверждаем наличие: ${money.format(
          result.product.requestedKg,
        )} кг краски «${result.product.name}»${
          color ? `, цвет — ${color}` : ""
        }. Цена — ${money.format(
          result.product.pricePerKg,
        )} ₽/кг, сумма — ${money.format(result.product.total)} ₽.`,
        logistics ? `Учли условия из заявки: ${logistics}.` : "",
        nextStep,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  return {
    subject,
    body: "Агент подготовил ответ по подтверждённым данным.",
  };
}

export function normalizeAgentResult(result, demoData, job = {}) {
  if (!result || typeof result !== "object") {
    throw new Error(
      "Ответ модели нужно пересобрать. Запустите обработку заказа снова.",
    );
  }
  if (hasSensitiveDraftText(result)) {
    return managerFallbackAgentResult(job, {
      reason: "Ответ модели содержит credential-подобные данные и закрыт для показа.",
    });
  }
  if (result.schemaVersion === 2) {
    return normalizeV2AgentResult(result, demoData, job);
  }
  const v2Envelope = normalizeV2Envelope(result, demoData, job);

  const rawOptionCount = Array.isArray(result.options)
    ? result.options.length
    : 0;
  const rawResearch = objectRecord(result.research);
  const rawResearchSources = Array.isArray(rawResearch?.sources)
    ? rawResearch.sources
    : [];
  const hadResearchClaim = Boolean(
    rawResearch?.checked ||
      text(rawResearch?.summary) ||
      rawResearchSources.length,
  );
  const rawClientCopy = [
    result.reply?.body,
    ...(Array.isArray(result.options)
      ? result.options.map((option) => option?.reply)
      : []),
  ].join("\n");
  const replacedUnexpectedLatin =
    hasUnexpectedLatin(result.reply?.subject) ||
    hasUnexpectedLatin(rawClientCopy) ||
    (Array.isArray(result.checks) &&
      result.checks.includes(safeTemplateReplacementCheck));
  const replacedForbiddenRhetoric =
    hasForbiddenContrast(result.reply?.subject) ||
    hasForbiddenContrast(rawClientCopy) ||
    (Array.isArray(result.checks) &&
      result.checks.includes(safeRhetoricReplacementCheck));
  const facts = orderFacts(job, demoData);
  const safeCalculation =
    fenceCalculation(facts, demoData) ??
    surfaceCalculation(facts, demoData) ??
    (facts.fence || facts.surface
      ? undefined
      : normalizeCalculation(result.calculation));
  const safeDecisionBasis = normalizeDecisionBasis(result.decisionBasis);
  const {
    sourceOrderText,
    explicitSku,
    matchedProduct,
    requestedKg: requestedFromText,
    firstDeliveryKg,
    color: requestedColor,
  } = facts;
  const requestedFromOrder =
    requestedFromText || safeCalculation?.roundedKg || 0;
  const explicitProduct = explicitSku ? matchedProduct : null;
  const modelSku = text(result.product?.sku).toUpperCase();
  const modelSkuMismatch = Boolean(
    matchedProduct && modelSku && modelSku !== matchedProduct.sku,
  );
  let sourceFactGaps = facts.gaps.filter(
    (gap) => !(safeCalculation && gap === "объём в килограммах"),
  );
  if (
    facts.surface?.kind === "floor" &&
    asksCompatibility(facts.sourceOrderText)
  ) {
    const floorQuestionParts = [
      ...(!facts.surface.material ? ["из чего сделан пол"] : []),
      ...(!facts.surface.areaM2 ? ["какая площадь пола"] : []),
      ...(!facts.floorUse.purpose ? ["как будете использовать помещение"] : []),
      ...(!facts.floorUse.cleaning ? ["чем его моете"] : []),
      ...(!facts.floorUse.load ? ["ездят ли по нему погрузчики"] : []),
    ];
    const lastQuestionPart = floorQuestionParts.pop();
    sourceFactGaps = [
      ...(lastQuestionPart
        ? [
            `Подскажите, пожалуйста: ${
              floorQuestionParts.length
                ? `${floorQuestionParts.join(", ")} и `
                : ""
            }${lastQuestionPart}?`,
          ]
        : []),
      ...sourceFactGaps.filter((gap) => gap === "приложите фотографию"),
    ];
  }
  let hardRedRiskDetected = false;
  let technicalReviewDetected = false;
  let technicalReviewReason = "";

  const suppliedUnderstanding = cleanList(result.understood);
  const company = cleanSourceText(job?.company, 180);
  const companyKey = company.toLocaleLowerCase("ru-RU");
  const floorUnderstanding =
    facts.surface?.kind === "floor"
      ? [
          ...(facts.floorUse.material
            ? [`Материал пола: ${facts.floorUse.material}`]
            : []),
          ...(facts.floorUse.purpose
            ? [`Назначение помещения: ${facts.floorUse.purpose}`]
            : []),
          ...(facts.floorUse.cleaning
            ? [`Уборка: ${facts.floorUse.cleaning}`]
            : []),
          ...(facts.floorUse.load
            ? [`Нагрузка: ${facts.floorUse.load}`]
            : []),
        ]
      : [];
  result.understood = [
    ...(company ? [`Клиент: ${company}`] : []),
    ...floorUnderstanding,
    ...suppliedUnderstanding.filter(
      (item) =>
        !(
          companyKey &&
          /^(?:клиент|компания)(?:\s|:|—|-)/iu.test(item) &&
            item.toLocaleLowerCase("ru-RU").includes(companyKey)
        ) &&
        !/^(?:материал пола|назначение помещения|уборка|нагрузка)(?:\s|:|—|-)/iu.test(
          item,
        ),
    ),
  ].slice(0, 8);
  result.missing = cleanList(result.missing);
  result.options = Array.isArray(result.options)
    ? result.options.filter(optionIsSafe).slice(0, 3)
    : [];
  result.confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  const researchMatch = companyResearchMatch(job, facts);
  result.research = researchMatch
    ? normalizeResearch(result.research, job, researchMatch === "name")
    : {
        checked: false,
        summary: "",
        sources: [],
      };
  const openedResearchSources = result.research.sources.filter((source) =>
    sourceWasOpened(source, job),
  );
  const allResearchClaimsGrounded =
    !hadResearchClaim ||
    (rawResearchSources.length > 0 &&
      result.research.sources.length === rawResearchSources.length &&
      openedResearchSources.length === rawResearchSources.length);
  const preparedResearch = preparedResearchFor(
    preparedProfileForJob(job, facts, demoData),
  );
  const hasGroundedModelResearch =
    allResearchClaimsGrounded && result.research.checked;
  const groundedResearchSources = hasGroundedModelResearch
    ? openedResearchSources
    : (preparedResearch?.sources ?? []);
  if (!hasGroundedModelResearch && preparedResearch) {
    result.research = preparedResearch;
  }
  result.calculation = safeCalculation;
  result.supplierPlan = undefined;
  result.decisionBasis = allResearchClaimsGrounded ? safeDecisionBasis : [];

  const industry = industryFor(job, demoData);
  result.businessContext =
    groundedBusinessContext({
      facts,
      industry,
      openedResearchSources: groundedResearchSources,
    }) ||
    "Агент опирается на задачу клиента и подтверждённые свойства выбранной краски.";

  if (explicitSku && !explicitProduct) {
    result.zone = "yellow";
    result.decision = "clarify";
    result.product = null;
    result.options = [];
    result.missing = [...sourceFactGaps];
    result.zoneReason =
      "Агент уточнит товар и сразу продолжит расчёт по каталогу.";
  } else {
    if (matchedProduct) {
      result.product = {
        sku: matchedProduct.sku,
        requestedKg: requestedFromOrder,
      };
    }
  }

  if (result.product?.sku) {
    const requestedSku = text(result.product.sku).toUpperCase();
    const sourceProduct = demoData.products.find(
      (product) => product.sku === requestedSku,
    );
    if (sourceProduct) {
      const requestedKg = requestedFromOrder;
      result.product = {
        sku: sourceProduct.sku,
        name: sourceProduct.name,
        stockKg: sourceProduct.stockKg,
        requestedKg,
        ...(firstDeliveryKg
          ? {
              firstDeliveryKg: Math.min(
                firstDeliveryKg,
                sourceProduct.stockKg,
                requestedKg,
              ),
            }
          : {}),
        ...(requestedColor ? { color: requestedColor } : {}),
        pricePerKg: sourceProduct.pricePerKg,
        minPricePerKg: sourceProduct.minPricePerKg,
        replenishmentDays: sourceProduct.replenishmentDays,
        total: requestedKg * sourceProduct.pricePerKg,
      };
      const currentDeliveryFacts = [
        ...(requestedColor ? [`Цвет: ${requestedColor}`] : []),
        ...(firstDeliveryKg
          ? [
              `Первая поставка: ${money.format(
                firstDeliveryKg,
              )} кг; затем ${money.format(
                requestedKg - firstDeliveryKg,
              )} кг`,
            ]
          : []),
      ];
      result.understood = [
        ...result.understood
          .filter(
            (item) =>
              !/^(?:цвет|первая\s+(?:поставка|партия))(?:\s|:|—|-)/iu.test(
                item,
              ),
          )
          .slice(0, 8 - currentDeliveryFacts.length),
        ...currentDeliveryFacts,
      ];
      result.market = marketSnapshot(sourceProduct, demoData, requestedKg);
      result.supplierPlan =
        requestedKg > sourceProduct.stockKg
          ? buildSupplierPlan(sourceProduct, demoData.market, requestedKg)
          : undefined;

      const marketDate = result.market.items[0]?.checkedAt;
      result.checks = [
        `Каталог подтверждает краску «${sourceProduct.name}» и её свойства`,
        `Остаток: ${money.format(sourceProduct.stockKg)} кг`,
        "По этой цене завод зарабатывает на заказе",
        marketDate
          ? `Цены и наличие других поставщиков проверены ${marketDate}`
          : "Цена сверена с описанием краски в каталоге и правилом заработка",
      ];
      result.sources = [
        "Входящее письмо",
        "Каталог и остатки",
        "Правила продаж",
        ...(result.market.items.length
          ? ["Цены и наличие других поставщиков"]
          : []),
        "Как заказ влияет на работу клиента",
      ];

      const requestedBelowMinimum = quotedUnitPrices(sourceOrderText).some(
        (price) => price < sourceProduct.minPricePerKg,
      );
      const replyBelowMinimum = quotedUnitPrices(rawClientCopy).some(
        (price) => price < sourceProduct.minPricePerKg,
      );
      const sourceHasSpecialTerms = hasSpecialTerms(sourceOrderText);
      const clientCopyHasSpecialTerms = hasSpecialTerms(rawClientCopy);
      technicalReviewDetected =
        requestedKg > 0 &&
        sourceFactGaps.length === 0 &&
        asksCompatibility(sourceOrderText) &&
        (facts.surface?.kind !== "floor" ||
          Boolean(
            facts.floorUse?.material &&
              facts.floorUse?.purpose &&
              facts.floorUse?.cleaning &&
              facts.floorUse?.load,
          )) &&
        !productCoversRequestedUse(sourceProduct, sourceOrderText);
      technicalReviewReason = technicalReviewDetected
        ? technicalReviewSummary(sourceOrderText)
        : "";

      if (
        requestedKg > sourceProduct.stockKg ||
        requestedBelowMinimum ||
        replyBelowMinimum ||
        sourceHasSpecialTerms ||
        clientCopyHasSpecialTerms ||
        technicalReviewDetected
      ) {
        hardRedRiskDetected = true;
        result.zone = "red";
        result.decision = "escalate";
        result.zoneReason =
          technicalReviewDetected
            ? `${technicalReviewReason} Агент подготовил три готовых хода для решения.`
            : requestedKg > sourceProduct.stockKg
            ? firstDeliveryKg
              ? `Клиент выбрал ${money.format(
                  firstDeliveryKg,
                )} кг для первой поставки. Склад подтверждает этот объём; руководитель получил план для оставшихся ${money.format(
                  requestedKg - firstDeliveryKg,
                )} кг.`
              : `Склад подтверждает ${money.format(
                  sourceProduct.stockKg,
                )} из ${money.format(
                  requestedKg,
                )} кг. Руководитель выберет готовый способ выполнить заказ.`
            : requestedBelowMinimum
              ? "Клиент предложил особую цену. Руководитель получил варианты, при которых завод заработает на заказе."
              : replyBelowMinimum
                ? "Руководитель выбирает один из готовых вариантов; рядом показан заработок завода."
                : clientCopyHasSpecialTerms
                  ? "Агент подготовил руководителю варианты цены, срока и оплаты."
                  : "Руководитель получил варианты по особым условиям заказа.";
        result.checks.push("Следующий шаг выбран по правилам завода");
      }

      const verifiedReady =
        requestedKg > 0 &&
        sourceFactGaps.length === 0 &&
        requestedKg <= sourceProduct.stockKg &&
        !requestedBelowMinimum &&
        !replyBelowMinimum &&
        !sourceHasSpecialTerms &&
        !clientCopyHasSpecialTerms &&
        !technicalReviewDetected;
      if (verifiedReady) {
        hardRedRiskDetected = false;
        result.zone = "green";
        result.decision = "quote";
        result.options = [];
        result.zoneReason =
          "Весь объём подтверждён складом. По этой цене завод зарабатывает на заказе. Письмо готово.";
        result.managerNote =
          "Цена и объём подтверждены. Письмо готово к отправке.";
      }

      if (requestedKg <= 0) {
        result.zone = "yellow";
        if (facts.surface) {
          result.zoneReason =
            "Агент уточнит, из чего сделан пол и как его используют, затем рассчитает расход по площади и целым упаковкам.";
        } else {
          result.product = null;
          result.missing = [
            ...new Set([...result.missing, "укажите объём в килограммах"]),
          ];
          result.zoneReason =
            "Агент уточнит объём и сразу соберёт точный расчёт.";
        }
      }

      if (result.zone === "red") {
        const optionIds = result.options.map((option) => text(option?.id));
        if (technicalReviewDetected) {
          result.options = technicalReviewOptions(
            sourceProduct,
            requestedKg,
            sourceOrderText,
          );
        } else if (
          rawOptionCount < 2 ||
          rawOptionCount > 3 ||
          result.options.length !== rawOptionCount ||
          optionIds.some((id) => !id) ||
          new Set(optionIds).size !== optionIds.length ||
          (requestedKg > sourceProduct.stockKg &&
            result.options.some(
              (option) =>
                !["supplier", "internal"].includes(
                  option.followUpActor,
                ),
            )) ||
          result.options.some((option) =>
            promisesUnavailableFullVolume(
              option,
              sourceProduct,
              requestedKg,
              demoData,
            ),
          ) ||
          result.options.some((option) =>
            quotesBelowMinimum(option, sourceProduct, demoData),
          ) ||
          result.options.some((option) =>
            offersUnapprovedAnalogue(option, sourceProduct, demoData),
          ) ||
          result.options.some((option) =>
            offersUnavailableColor(
              option,
              sourceProduct,
              sourceOrderText,
              demoData,
            ),
          ) ||
          (firstDeliveryKg > 0 &&
            requestedKg > sourceProduct.stockKg) ||
          (result.calculation &&
            result.options.some(
              (option) =>
                targetProductForOption(option, sourceProduct, demoData).sku !==
                sourceProduct.sku,
            ))
        ) {
          result.options = fallbackOptions(
            sourceProduct,
            requestedKg,
            demoData,
            !result.calculation,
            sourceOrderText,
            firstDeliveryKg,
          );
        }

        if (
          !technicalReviewDetected &&
          requestedKg > sourceProduct.stockKg
        ) {
          const supplierHelp = fallbackOptions(
            sourceProduct,
            requestedKg,
            demoData,
            !result.calculation,
            sourceOrderText,
            firstDeliveryKg,
          ).find(
            (option) => option.id === "помочь-с-недостающим-объёмом",
          );
          if (
            supplierHelp &&
            !result.options.some(
              (option) =>
                option.id === "помочь-с-недостающим-объёмом",
            )
          ) {
            result.options = [
              ...result.options.slice(0, 2),
              supplierHelp,
            ];
          }
        }
      }
    } else {
      result.zone = "yellow";
      result.decision = "clarify";
      result.product = null;
      result.options = [];
      result.missing = [
        ...new Set([
          ...result.missing,
          `сверьте код ${requestedSku || "из письма"} с каталогом`,
        ]),
      ];
      result.zoneReason =
        "Агент уточнит товар и продолжит расчёт по каталогу.";
    }
  } else if (result.zone !== "yellow") {
    result.zone = "yellow";
    result.decision = "clarify";
    result.product = null;
    result.options = [];
    result.missing = [
      ...new Set([...result.missing, "подтвердите краску или задачу"]),
    ];
    result.zoneReason =
      "Агент уточнит назначение и подберёт товар по каталогу.";
  }

  if (modelSkuMismatch) {
    const modelSkuLabel = /^КР-\d{1,4}$/i.test(modelSku)
      ? modelSku
      : "другой код";
    sourceFactGaps.unshift(
      `сверьте код: модель указала ${modelSkuLabel}, письмо соответствует ${matchedProduct.sku}`,
    );
  }

  if (sourceFactGaps.length) {
    result.missing = [...new Set(sourceFactGaps)];
    const preserveHardRed =
      hardRedRiskDetected &&
      Boolean(matchedProduct) &&
      requestedFromOrder > 0 &&
      !modelSkuMismatch;
    if (preserveHardRed) {
      result.zone = "red";
    } else {
      result.zone = "yellow";
      result.options = [];
      if (!matchedProduct) result.product = null;
      result.zoneReason = modelSkuMismatch
        ? "Агент сверит товар с письмом и продолжит по подтверждённому описанию в каталоге."
        : explicitSku && !matchedProduct
          ? "Агент уточнит товар и продолжит расчёт по каталогу."
          : "Агент собрал известные данные и подготовил короткие вопросы клиенту.";
    }
  }

  if (!["green", "yellow", "red"].includes(result.zone)) {
    throw new Error(
      "Ответ модели нужно пересобрать. Запустите обработку заказа снова.",
    );
  }

  result.decision =
    result.zone === "red"
      ? "escalate"
      : result.zone === "yellow"
        ? "clarify"
        : "quote";

  const suppliedReason = allResearchClaimsGrounded
    ? cleanCopy(result.zoneReason)
    : "";
  result.zoneReason =
    suppliedReason ||
    (
      result.zone === "green"
        ? "Краска, объём и цена подтверждены."
        : result.zone === "yellow"
          ? "Добавьте данные для выбора краски и расчёта."
          : "Руководитель выбирает вариант по условиям заказа."
    );

  const suppliedManagerNote = allResearchClaimsGrounded
    ? cleanCopy(result.managerNote)
    : "";
  result.managerNote =
    technicalReviewDetected
      ? "Выберите способ проверки. Технолог уже получает описание помещения, описание краски из каталога, расчёт и условие клиента."
      : suppliedManagerNote ||
        (result.zone === "red"
          ? industry
            ? `Предлагаем: ${industry.play}.`
            : "Предлагаем выполнимый график и закреплённую цену."
          : result.zone === "yellow"
            ? "Отправьте короткие вопросы. Ответ клиента продолжит тот же заказ."
            : "Цена и объём подтверждены. Письмо готово.");

  if (!result.product) {
    result.market = {
      checked: false,
      summary: "Сравнение цен начнётся после уточнения краски.",
      position: "Краска пока подбирается.",
      profitOpportunity:
        "После подбора агент сравнит нашу цену с ценами других поставщиков.",
      items: [],
    };
    result.checks = [
      "Запрошены данные для выбора краски и расчёта",
      "Расчёт начнётся после подтверждения краски",
    ];
    result.sources = ["Входящее письмо", "Правила продаж"];
  }

  const groundedBasis = [];
  const guardedProduct = result.product
    ? demoData.products.find((item) => item.sku === result.product.sku)
    : null;
  if (result.calculation) {
    groundedBasis.push({
      fact: result.calculation.explanation,
      source: "Размеры клиента и описание краски в каталоге",
      checkedAt: new Intl.DateTimeFormat("ru-RU").format(new Date()),
      stockVersion: "",
    });
  }
  if (result.product && guardedProduct) {
    groundedBasis.push({
      fact: `Каталог подтверждает для «${guardedProduct.name}»: ${guardedProduct.features.join(
        ", ",
      )}.`,
      source: "Описание краски в каталоге",
      checkedAt: "Редакция демонстрационного каталога",
      stockVersion: "",
    });
    if (result.product.requestedKg > 0) {
      groundedBasis.push(
      {
        fact:
          result.product.requestedKg <= result.product.stockKg
            ? `Весь объём подтверждён складом: ${money.format(
                result.product.requestedKg,
              )} из ${money.format(result.product.stockKg)} кг.`
            : `Склад подтверждает ${money.format(
                result.product.stockKg,
              )} из ${money.format(result.product.requestedKg)} кг.`,
        source: "Остаток на момент расчёта",
        checkedAt:
          cleanSourceText(guardedProduct.stockUpdatedAt, 80) ||
          new Intl.DateTimeFormat("ru-RU").format(new Date()),
        stockVersion: guardedProduct.stockRevision
          ? `Обновление склада №${guardedProduct.stockRevision}`
          : "Исходное обновление склада",
      },
      );
    }
    groundedBasis.push({
      fact: `Цена ${money.format(
        result.product.pricePerKg,
      )} ₽/кг. Завод зарабатывает при цене от ${money.format(
        guardedProduct.minPricePerKg,
      )} ₽/кг.`,
      source: "Описание краски в каталоге и правила продаж",
      checkedAt: "Редакция 6.0",
      stockVersion: "",
    });
    if (result.market?.position && result.market.items?.length) {
      const comparedPrices = result.market.items
        .map(
          (item) =>
            `${cleanSourceText(item.competitor, 100)} — ${money.format(
              Number(item.pricePerKg),
            )} ₽/кг${
              Number.isFinite(Number(item.stockKg))
                ? `, в таблице указано ${money.format(
                    Number(item.stockKg),
                  )} кг`
                : ""
            }`,
        )
        .join("; ");
      groundedBasis.push({
        fact: `${result.market.position} Для сравнения: ${comparedPrices}.`,
        source: "Таблица цен и наличия поставщиков",
        checkedAt:
          result.market.items?.at(-1)?.stockCheckedAt ??
          result.market.items?.at(-1)?.checkedAt ??
          new Intl.DateTimeFormat("ru-RU").format(new Date()),
        stockVersion: "",
      });
    }
    if (result.supplierPlan) {
      const plan = result.supplierPlan;
      const savedDays = Math.max(
        0,
        guardedProduct.replenishmentDays - plan.deliveryDays,
      );
      const savedMoney = Math.max(
        0,
        result.product.requestedKg * result.product.pricePerKg - plan.total,
      );
      groundedBasis.push({
        fact: `План совместной поставки содержит недостающие ${money.format(
          plan.supplierKg,
        )} кг: со склада «Колера» — ${money.format(
          plan.ourKg,
        )} кг, по данным «${plan.supplierName}» — ${money.format(
          plan.supplierKg,
        )} кг. После подтверждения поставщика клиент получит все ${money.format(
          result.product.requestedKg,
        )} кг за ${plan.deliveryDays} ${countedNoun(
          plan.deliveryDays,
          "день",
          "дня",
          "дней",
        )}; стоимость — ${money.format(plan.total)} ₽${
          savedDays
            ? `, выигрыш по сроку — ${money.format(savedDays)} ${countedNoun(
                savedDays,
                "день",
                "дня",
                "дней",
              )}`
            : ""
        }${savedMoney ? `, экономия — ${money.format(savedMoney)} ₽` : ""}.`,
        source: "Таблица цен и наличия поставщиков",
        checkedAt: plan.stockCheckedAt,
        stockVersion: "",
      });
    }
  }
  for (const source of groundedResearchSources) {
    groundedBasis.push({
      fact: source.fact,
      source: source.title,
      checkedAt: source.checkedAt,
      stockVersion: "",
    });
  }
  result.decisionBasis = groundedBasis.length
    ? groundedBasis.slice(0, 6)
    : result.decisionBasis.length
      ? result.decisionBasis
      : [
          {
            fact: result.zoneReason,
            source: "Входящее письмо и правила продаж",
            checkedAt: new Intl.DateTimeFormat("ru-RU").format(new Date()),
            stockVersion: "",
          },
        ];

  const suppliedReply = result.reply && {
    subject: isAllCapsHeading(result.reply.subject)
      ? ""
      : cleanCopy(result.reply.subject),
    body: allResearchClaimsGrounded
      ? cleanClientCopy(result.reply.body)
      : "",
  };
  result.reply =
    result.zone === "yellow"
      ? fallbackReply(result, job, demoData, facts)
      : result.zone === "green"
        ? fallbackReply(result, job, demoData, facts)
        : suppliedReply?.subject && suppliedReply.body
          ? suppliedReply
          : fallbackReply(result, job, demoData, facts);

  if (result.zone === "red") {
    result.reply = {
      subject: result.reply.subject,
      body: "Выберите один подготовленный вариант — его условия войдут в письмо клиенту.",
    };
  } else {
    result.options = [];
  }
  if (replacedUnexpectedLatin) {
    result.checks = [
      ...new Set([...(result.checks ?? []), safeTemplateReplacementCheck]),
    ];
  }
  if (replacedForbiddenRhetoric) {
    result.checks = [
      ...new Set([...(result.checks ?? []), safeRhetoricReplacementCheck]),
    ];
  }

  const normalized = {
    zone: result.zone,
    decision: result.decision,
    route:
      result.zone === "red"
        ? "manager"
        : result.zone === "yellow"
          ? "needs_info"
          : "ready",
    confidence: result.confidence,
    understood: result.understood,
    missing: result.missing,
    product: result.product
      ? {
          sku: result.product.sku,
          name: result.product.name,
          stockKg: result.product.stockKg,
          requestedKg: result.product.requestedKg,
          ...(result.product.firstDeliveryKg
            ? { firstDeliveryKg: result.product.firstDeliveryKg }
            : {}),
          ...(result.product.color ? { color: result.product.color } : {}),
          pricePerKg: result.product.pricePerKg,
          total: result.product.total,
          replenishmentDays: result.product.replenishmentDays,
        }
      : null,
    ...(result.calculation ? { calculation: result.calculation } : {}),
    market: result.market,
    ...(result.supplierPlan ? { supplierPlan: result.supplierPlan } : {}),
    research: result.research,
    businessContext: result.businessContext,
    zoneReason: result.zoneReason,
    managerNote: result.managerNote,
    options: result.options,
    reply: result.reply,
    checks: result.checks,
    sources: result.sources,
    decisionBasis: result.decisionBasis,
    review: {
      model: cleanSourceText(result.review?.model, 120),
      verdict: cleanCopy(result.review?.verdict),
      notes: cleanList(result.review?.notes).slice(0, 4),
    },
  };
  return applyV2Envelope(normalized, v2Envelope, demoData);
}

function applyV2ReviewerResult(result, review, reviewerModel) {
  const blockingIssues = Array.isArray(review?.blockingIssues)
    ? review.blockingIssues
    : null;
  const approved =
    review?.approved === true &&
    blockingIssues !== null &&
    blockingIssues.length === 0;
  const suppliedNotes = Array.isArray(review?.notes)
    ? review.notes
        .map((item) => cleanCopy(String(item).slice(0, 260)))
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const defaultApprovedNotes =
    result.commitment === "estimate"
      ? ["Диапазон отделён от точной цены, резерва и отгрузки."]
      : result.product
        ? [
            `Склад подтверждает ${money.format(
              result.product.stockKg,
            )} кг; запрошено ${money.format(
              result.product.requestedKg,
            )} кг.`,
            `Цена ${money.format(
              result.product.pricePerKg,
            )} ₽/кг взята из переданного снимка.`,
          ]
        : ["Неподтверждённые коммерческие поля не используются."];

  if (approved) {
    result.review = {
      model: cleanSourceText(reviewerModel, 120),
      verdict:
        result.route === "ready"
          ? "Ответ проверен и готов к отправке"
          : result.route === "needs_info"
            ? "Вопрос проверен и готов к отправке"
            : "Руководитель получил готовые варианты",
      notes: suppliedNotes.length ? suppliedNotes : defaultApprovedNotes,
    };
    return result;
  }

  const blockingNotes = (blockingIssues ?? [])
    .map((item) =>
      cleanCopy(`Для решения: ${String(item).slice(0, 240)}`),
    )
    .filter(Boolean)
    .slice(0, 2);
  if (review?.unavailable === true && isFailClosedTargetAmbiguity(result)) {
    const unavailableNote =
      "Модель проверки недоступна; единственный безопасный вопрос сохранён без новых обязательств.";
    result.managerNote = unavailableNote;
    result.review = {
      model: cleanSourceText(reviewerModel, 120),
      verdict:
        cleanCopy(review?.verdict) ||
        "Безопасный вопрос сохранён до повторной проверки",
      notes: [unavailableNote, ...blockingNotes, ...suppliedNotes].slice(0, 4),
    };
    return result;
  }
  if (review?.unavailable === true && result.commitment === "estimate") {
    const managerEstimate = result.route === "manager";
    const unavailableNote = managerEstimate
      ? "Модель проверки недоступна; честные диапазоны сохранены для решения руководителя без резерва и точного обещания."
      : "Модель проверки недоступна; программно проверенный диапазон остаётся предварительной оценкой без резерва и точного обещания.";
    const guardedOptions = managerEstimate
      ? safeV2ManagerOptions(result.options)
      : [];
    result.zone = managerEstimate ? "red" : "yellow";
    result.decision = managerEstimate ? "escalate" : "clarify";
    result.route = managerEstimate ? "manager" : "ready";
    result.managerNote = unavailableNote;
    result.options = managerEstimate
      ? guardedOptions.length >= 2
        ? guardedOptions
        : v2ReviewOptions()
      : [];
    if (managerEstimate) result.reply = manualReviewReply(result.reply);
    result.review = {
      model: cleanSourceText(reviewerModel, 120),
      verdict:
        cleanCopy(review?.verdict) ||
        managerEstimate
          ? "Руководитель получил диапазон без автоматического review"
          : "Предварительная оценка сохранена без коммерческого обязательства",
      notes: [unavailableNote, ...blockingNotes, ...suppliedNotes].slice(0, 4),
    };
    return result;
  }
  if (review?.unavailable === true && result.route === "manager") {
    const hadCommercialCommitment = result.commitment === "commercial_offer";
    const unavailableNote =
      "Модель проверки недоступна; программно проверенные факты и варианты сохранены для решения руководителя.";
    result.zone = "red";
    result.decision = "escalate";
    result.route = "manager";
    result.commitment = "none";
    if (hadCommercialCommitment) {
      result.product = null;
      result.market = v2EmptyMarket();
      delete result.calculation;
      delete result.supplierPlan;
    }
    result.managerNote = unavailableNote;
    result.reply = manualReviewReply(result.reply);
    result.review = {
      model: cleanSourceText(reviewerModel, 120),
      verdict:
        cleanCopy(review?.verdict) ||
        "Руководитель получил проверенные факты без автоматического review",
      notes: [unavailableNote, ...blockingNotes, ...suppliedNotes].slice(0, 4),
    };
    return result;
  }
  const preserveBoundaryOptions =
    result.commitment === "none" &&
    result.resolvedIntent?.target?.state === "resolved";
  const guardedBoundaryOptions = preserveBoundaryOptions
    ? safeV2ManagerOptions(result.options)
    : [];
  const primaryReply = manualReviewReply(result.reply);
  result.zone = "red";
  result.decision = "escalate";
  result.route = "manager";
  result.commitment = "none";
  result.missing = result.resolvedIntent?.blocker
    ? [result.resolvedIntent.blocker.question]
    : [];
  result.product = null;
  result.estimates = [];
  result.market = v2EmptyMarket();
  delete result.calculation;
  delete result.supplierPlan;
  result.options = preserveBoundaryOptions
    ? guardedBoundaryOptions.length >= 2
      ? guardedBoundaryOptions
      : v2BoundaryOptions(result)
    : v2ReviewOptions();
  result.zoneReason =
    "Reviewer отметил условие, которое нужно проверить до ответа клиенту.";
  result.managerNote =
    "Проверьте отмеченное условие и выберите безопасный следующий шаг.";
  result.reply = primaryReply;
  result.review = {
    model: cleanSourceText(reviewerModel, 120),
    verdict:
      cleanCopy(review?.verdict) ||
      "Руководитель получил пункты для проверки",
    notes: [...blockingNotes, ...suppliedNotes].slice(0, 4),
  };
  return result;
}

function reviewerInputForApply(review, result, job) {
  if (review?.schemaVersion !== 2) return review;
  const normalized = normalizeReviewerDecisionV2(review, {
    order: job,
    result,
  });
  if (!normalized) {
    return {
      approved: false,
      verdict: "Решение reviewer не прошло контрактную проверку",
      notes: [],
      blockingIssues: [
        "Контракт reviewer не прошёл проверку; требуется ручная проверка.",
      ],
    };
  }
  return {
    approved: normalized.approved,
    verdict: normalized.verdict,
    notes: normalized.notes,
    blockingIssues: normalized.blockingIssues.map((issue) => issue.detail),
  };
}

export function applyReviewerResult(
  result,
  review,
  reviewerModel,
  demoData,
  job = {},
) {
  if (hasSensitiveDraftText(result) || hasSensitiveDraftText(review)) {
    return managerFallbackAgentResult(job, {
      reason: "Данные проверки содержат credential-подобные данные и закрыты для показа.",
    });
  }
  if (result?.schemaVersion === 2) {
    return applyV2ReviewerResult(
      result,
      reviewerInputForApply(review, result, job),
      reviewerModel,
    );
  }
  const facts = orderFacts(job, demoData);
  const hasBlockingIssuesArray = Array.isArray(review?.blockingIssues);
  const blockingIssues = hasBlockingIssuesArray
    ? review.blockingIssues
    : [];
  const reviewerApproved =
    review?.approved === true &&
    hasBlockingIssuesArray &&
    blockingIssues.length === 0;
  const blockingNotes = blockingIssues
    .slice(0, 2)
    .map((item) => cleanCopy(`Для решения: ${String(item).slice(0, 240)}`))
    .filter(Boolean);
  const reviewNotes = Array.isArray(review?.notes)
    ? review.notes
        .slice(0, 4)
        .map((item) => cleanCopy(String(item).slice(0, 260)))
        .filter(Boolean)
    : [];
  const reviewVerdict = cleanCopy(review?.verdict);

  const readyProduct = result.product
    ? demoData.products.find((item) => item.sku === result.product.sku)
    : null;
  const readyDetails = [
    colorLabelFromText(facts.sourceOrderText) ? "цвет" : "",
    orderLogisticsLine(facts.sourceOrderText) ? "условия поставки" : "",
  ].filter(Boolean);
  const approvedReadyNotes =
    result.route === "ready" && result.product && readyProduct
      ? [
          `Склад подтверждает ${money.format(
            result.product.requestedKg,
          )} кг из ${money.format(result.product.stockKg)} кг.`,
          `Цена ${money.format(
            result.product.pricePerKg,
          )} ₽/кг выше нижней выгодной границы ${money.format(
            readyProduct.minPricePerKg,
          )} ₽/кг — заказ приносит прибыль.`,
          readyDetails.length
            ? `Письмо повторяет ${readyDetails.join(" и ")} из заявки.`
            : "Письмо повторяет подтверждённые данные заказа.",
        ]
      : [];

  result.review = {
    model: reviewerModel,
    verdict:
      reviewerApproved && result.route === "ready"
        ? "Ответ проверен и готов к отправке"
        : reviewerApproved && result.route === "needs_info"
          ? "Вопросы проверены и готовы к отправке"
          : reviewerApproved && result.route === "manager"
            ? "Руководитель получил готовые варианты"
            : reviewVerdict
              ? reviewVerdict.slice(0, 240)
              : "Руководителю подготовлены пункты для решения",
    notes: reviewerApproved
      ? approvedReadyNotes.length
        ? approvedReadyNotes
        : reviewNotes
      : [...blockingNotes, ...reviewNotes].slice(0, 4),
  };

  if (reviewerApproved) return result;
  if (result.schemaVersion === 2) {
    result.zone = "red";
    result.decision = "escalate";
    result.route = "manager";
    result.commitment = "none";
    result.missing = result.resolvedIntent?.blocker
      ? [result.resolvedIntent.blocker.question]
      : [];
    result.options = v2ReviewOptions();
    result.zoneReason =
      "Reviewer отметил условие, которое нужно проверить до ответа клиенту.";
    result.managerNote =
      "Проверьте отмеченное условие и выберите безопасный следующий шаг.";
    result.reply = {
      subject: "Проверка предложения",
      body: "Руководитель получил замечания reviewer и готовые варианты проверки.",
    };
    return result;
  }

  const mismatchNote = result.missing?.find((item) =>
    /^сверьте код: модель указала (?:КР-\d{1,4}|другой код), письмо соответствует КР-\d{1,4}$/iu.test(
      item,
    ),
  );
  const canAskClient =
    !hasCommercialBoundary(facts) &&
    (facts.gaps.length > 0 || Boolean(mismatchNote));
  if (canAskClient) {
    result.zone = "yellow";
    result.decision = "clarify";
    result.missing = [...new Set([mismatchNote, ...facts.gaps].filter(Boolean))];
    result.options = [];
    result.businessContext = facts.matchedProduct
      ? "Письмо и каталог собраны. Ответ клиента завершит расчёт по остатку на момент расчёта."
      : "Письмо разобрано. Агент подготовил вопросы, после которых подберёт краску и рассчитает заказ.";
    result.zoneReason =
      "Агент собрал известные данные и подготовил короткие вопросы клиенту.";
    result.managerNote =
      "Отправьте точные вопросы. Ответ клиента продолжит тот же заказ.";
    const clarified = normalizeAgentResult(result, demoData, job);
    clarified.understood = groundedUnderstanding(job, facts);
    return clarified;
  }

  result.zone = "red";
  result.decision = "escalate";
  result.zoneReason =
    "Модель проверки отметила условие для руководителя и приложила факты.";
  result.managerNote = `Модель проверки подготовила данные для выбора. ${result.managerNote}`;
  result.options = [];
  const normalized = normalizeAgentResult(result, demoData, job);
  normalized.understood = groundedUnderstanding(job, facts);
  normalized.missing = [
    ...new Set([mismatchNote, ...facts.gaps].filter(Boolean)),
  ];
  const missing =
    normalized.missing.slice(0, 2).join(", ") ||
    "условие, отмеченное сильной моделью";
  const safeQuestionReply =
    "Что для вас важнее: срок, цена или график поставки? После ответа подготовим подтверждённый вариант.";

  normalized.zone = "red";
  normalized.decision = "escalate";
  normalized.route = "manager";
  const hasProduct = Boolean(normalized.product ?? facts.matchedProduct);
  const hasResearchSources = Boolean(normalized.research?.sources.length);
  normalized.zoneReason = hasProduct
    ? "Письмо, каталог и склад подтверждают данные для решения руководителя."
    : "Письмо содержит данные для решения руководителя.";
  normalized.managerNote = hasResearchSources
    ? "Откройте найденные ссылки и выберите один из подготовленных ходов."
    : "Выберите один из подготовленных ходов по данным заявки.";
  normalized.businessContext = hasProduct
    ? hasResearchSources
      ? "Письмо, каталог, склад и найденные ссылки собраны рядом с решением руководителя."
      : "Письмо, каталог и склад собраны рядом с решением руководителя."
    : hasResearchSources
      ? "Письмо и найденные ссылки собраны рядом с решением руководителя."
      : "Письмо даёт руководителю данные для следующего шага.";
  if (normalized.research) {
    if (hasResearchSources) {
      const researchTitles = new Set(
        normalized.research.sources.map((source) => source.title),
      );
      normalized.research.checked = false;
      normalized.research.sources = normalized.research.sources.map(
        (source) => ({
          ...source,
          fact: "Источник найден. Руководитель проверяет сведения перед решением.",
        }),
      );
      normalized.decisionBasis = normalized.decisionBasis.filter(
        (basis) => !researchTitles.has(basis.source),
      );
      if (normalized.decisionBasis.length === 0) {
        normalized.decisionBasis = [
          {
            fact: "Запрос клиента сохранён на странице заказа.",
            source: "Входящее письмо",
            checkedAt: new Intl.DateTimeFormat("ru-RU").format(new Date()),
            stockVersion: "",
          },
        ];
      }
    }
    normalized.research.summary = hasResearchSources
      ? "Агент нашёл ссылки на открытые страницы. Руководитель проверит сведения перед решением."
      : normalized.research.summary
        ? "Публичный поиск завершён. Решение опирается на письмо и внутренние данные."
        : "";
  }
  normalized.options = [
    {
      id: "review-ask",
      title: "Уточнить один факт у клиента",
      rationale: `Уточнить у клиента: ${missing}.`,
      tradeoff: "Расчёт продолжится после одного ответа.",
      reply: safeQuestionReply,
    },
    {
      id: "review-check",
      title: "Проверить условие внутри компании",
      rationale:
        "Подключить коллег, которые отвечают за наличие, свойства краски и оплату, и получить точный ответ.",
      tradeoff:
        "Команда даст клиенту подтверждённый ответ после внутренней проверки.",
      reply:
        "Ваш запрос принят. Проверяем условия со специалистами и направим подтверждённый ответ после согласования.",
    },
    {
      id: "review-call",
      title: "Уточнить, что важнее клиенту",
      rationale:
        "Провести короткий разговор и выбрать подходящие срок, цену и условия.",
      tradeoff: "Менеджер подключится к следующему контакту.",
      reply:
        "Что для вас важнее: срок, цена или условия поставки? После разговора сразу закрепим выполнимый вариант.",
    },
  ];
  normalized.reply = {
    subject: `Ответ по заказу: ${cleanCopy(job?.subject) || "краска"}`,
    body:
      "Агент подготовил следующие ходы. Письмо получит текст выбранного руководителем варианта.",
  };
  return normalized;
}
