import {
  CONTENT_CATEGORIES,
  SIGNS_FOR_CONTENT,
  contentKey,
  defaultNote,
  type ContentCategory,
} from "@/lib/content";
import type { Locale } from "@/lib/i18n";
import { canEditKnowledge } from "@/lib/roles";
import type { Role } from "@/lib/types";

/**
 * Editorial-override policy (`api/admin/knowledge`), extracted for testing.
 *
 * The bug this encodes against (product amendment §P4): the admin panel seeds
 * its textarea with the *effective* value —
 * `notes[key] ?? defaultNote(category, item, locale)` — so an editor who opens a
 * note and presses Save without typing anything silently converts a built-in
 * default into a stored override. Nothing in the UI distinguishes the two, and
 * there is no delete path, so the conversion is permanent.
 *
 * `isOverride` tells the caller which state a submission is in. The route still
 * stores the body (saving the default explicitly is legitimate — an editor may
 * want to freeze wording that is about to change in code), but it can now say
 * which one happened, and a future "reset to default" has something to delete.
 */

export const MAX_BODY_LENGTH = 4_000;

export type KnowledgeSubmission = {
  category: ContentCategory;
  item: string;
  locale: Locale;
  body: string;
};

export type KnowledgeRejection =
  | { status: 403; error: "not_authorized" }
  | { status: 400; error: "invalid_content" };

export type KnowledgeDecision =
  | {
      allowed: true;
      key: string;
      title: string;
      body: string;
      /** The submission equals the code default: storing it creates an override. */
      isOverride: boolean;
      /** True when this exact text is already what the reader sees. */
      matchesDefault: boolean;
    }
  | { allowed: false; rejection: KnowledgeRejection };

export function assessKnowledgeEdit(input: {
  actor: { role: Role };
  data: {
    category?: unknown;
    item?: unknown;
    sign?: unknown;
    locale?: unknown;
    body?: unknown;
  } | null;
  /** Existing overrides, keyed by `contentKey`. */
  overrides?: Record<string, string>;
}): KnowledgeDecision {
  if (!canEditKnowledge(input.actor.role)) {
    return { allowed: false, rejection: { status: 403, error: "not_authorized" } };
  }

  const category = (input.data?.category ?? "sun") as ContentCategory;
  const rawItem = input.data?.item ?? input.data?.sign ?? "";
  const item = typeof rawItem === "string" ? rawItem : "";
  const locale: Locale = input.data?.locale === "es" ? "es" : "en";

  const itemIsValid = category === "house"
    ? /^(?:[1-9]|1[0-2])$/.test(item)
    : SIGNS_FOR_CONTENT.includes(item);

  const body = input.data?.body;
  if (
    !CONTENT_CATEGORIES.includes(category)
    || !itemIsValid
    || typeof body !== "string"
    || !body.trim()
    || body.length > MAX_BODY_LENGTH
  ) {
    return { allowed: false, rejection: { status: 400, error: "invalid_content" } };
  }

  const key = contentKey(category, item, locale);
  const trimmed = body.trim();
  // An empty default means the built-in has no copy for this cell, so any text
  // is genuinely new rather than a re-save of a default.
  const compiled = defaultNote(category, item, locale);

  return {
    allowed: true,
    key,
    title: `${category}: ${item} (${locale})`,
    body: trimmed,
    isOverride: compiled.length > 0 && trimmed === compiled,
    matchesDefault: trimmed === compiled,
  };
}
