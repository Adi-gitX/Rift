/**
 * Claude-powered preview bundle review.
 *
 * For each ready preview, we ask Claude Haiku to produce a 3-bullet
 * summary of what the reviewer should look at (visible UI, behaviour,
 * potential issues). Output is appended to the sticky PR comment under
 * a clearly-marked "AI review" section.
 *
 * Failures are non-fatal: if no API key is configured, or Anthropic
 * returns an error, we skip silently and the comment posts without
 * the review. This makes the feature opt-in without breaking the
 * core preview flow.
 */
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_BUNDLE_CHARS = 30_000;

export interface BundleReviewInput {
  /** Caller-supplied bundle source text. For static-synth previews, the
   *  synthesised Worker module (which embeds the user's HTML/CSS). */
  bundleSource: string;
  prNumber: number;
  repoFullName: string;
  /** Optional: cached prompt prefix used by Anthropic to skip re-tokenisation
   *  on subsequent calls for the same repo. */
  systemPrompt?: string;
}

export interface BundleReviewResult {
  /** Markdown body suitable for embedding into a PR comment. */
  markdown: string;
  /** Anthropic input/output token counts (for cost surfacing). */
  usage: { inputTokens: number; outputTokens: number };
}

const DEFAULT_SYSTEM = [
  'You review per-PR Cloudflare Workers preview deployments.',
  'You are given the synthesised Worker module that serves the preview',
  'including any inlined HTML/CSS/JS from the customer\'s repo.',
  'Reply with EXACTLY 3 short markdown bullets (≤20 words each):',
  '  1. **What changed** — visible UI / behaviour the reviewer will see',
  '  2. **Risk** — anything that could break in production',
  '  3. **Try this** — one specific thing for the reviewer to click/check',
  'No preamble. No closing. Just the 3 bullets.',
].join(' ');

export const reviewBundle = async (
  apiKey: string,
  input: BundleReviewInput,
): Promise<BundleReviewResult | null> => {
  const truncated = input.bundleSource.length > MAX_BUNDLE_CHARS;
  const sample = input.bundleSource.slice(0, MAX_BUNDLE_CHARS);
  const userMessage = [
    `Repo: ${input.repoFullName} · PR #${input.prNumber}`,
    truncated ? `(bundle truncated to first ${MAX_BUNDLE_CHARS} chars; full size ${input.bundleSource.length})` : `(${input.bundleSource.length} bytes)`,
    '',
    '```javascript',
    sample,
    '```',
  ].join('\n');

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: input.systemPrompt ?? DEFAULT_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  type AnthropicMessage = {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const data = (await res.json()) as AnthropicMessage;
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!.trim())
    .join('\n')
    .trim();
  if (!text) return null;
  return {
    markdown: text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
};
