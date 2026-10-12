# Local manuscript preparation: issue #38 evaluation

Status: testing in progress. These are experimental prompts, not a claim of Gemini-equivalent quality.

## Scope

No application code or existing prep presets changed. Separate prompt files are under `docs/prompts/`. Local-only test requests and results are under `data/local_llm_evaluation/`, excluded through this checkout's `.git/info/exclude`. Model downloads are in LM Studio's user model directory, outside the repository.

## What the issue actually reports

The reporter uses Windows 11, an RTX 3060 with 12 GB VRAM, Ollama, Qwen3.5 9B, a 32K context setting, 32,000 maximum generated tokens, a 120-second request timeout, and chapter chunking disabled. Even a short passage timed out repeatedly. This is not evidence that the passage itself exceeded context.

The current Ollama adapter sends `options.reasoning=false`. Ollama documents a top-level `think:false` instead. Consequently, the application's Disable Reasoning checkbox cannot be relied upon to disable Ollama thinking. The adapter also requests a non-streaming response, so it waits for completion before receiving the answer. A timeout does not demonstrate a model crash or a prompt too large to fit; the server can still be busy generating. Do not repeatedly retry a slow request without checking server activity.

The LM Studio adapter sends `reasoning: {enabled: false}`. In this installation, tests through that unchanged adapter still returned substantial `reasoning_content`. The native LM Studio API's documented `reasoning: "off"` disabled thinking in a diagnostic, but that is a different API path and is NOT proof the application currently does so.

## Context versus output

Context must accommodate instructions, supplied manuscript, output tags/directions, copied manuscript, and any reasoning. Maximum output tokens are a generation ceiling, not a context allocation or a target answer length. A 32K context and a 32K output ceiling leave no room for the input if fully used.

Start with 16,384 loaded context and section-sized input, not a complete novel. The existing chunk size is measured in words and is a soft paragraph boundary: a long paragraph can exceed the requested size. The current cross-section memory supplies speaker tag names, not full earlier chapters or a detailed identity/alias summary. No prompt can recover missing context or retrospectively rename already completed sections.

## Models selected for comparison

| Model | Quantization | Download reported by LM Studio | Purpose |
| --- | --- | --- | --- |
| Qwen3.5 9B | Q4_K_M | 6.55 GB including vision projector | Same family as reporter; strongest candidate to investigate, but reasoning must be controlled or budgeted |
| Qwen2.5 7B Instruct | Q4_K_M | 4.68 GB | Non-reasoning, lower-memory compatibility baseline |
| Gemma 3 12B IT | Q4_K_M | 8.15 GB including vision projector | Alternative instruction-tuned family without the same thinking overhead |
| Gemma 4 12B IT | Q4_K_M | 7.56 GB | Newer instruction-tuned candidate; initial tests completed |

Download size is NOT peak VRAM use. KV cache, runtime buffers, context, and the Windows desktop also consume VRAM. Tests here use an RTX 3080 Ti 12 GB, not the reporter's RTX 3060; measured speed must not be promised on their card. Before testing, the idle Breeze worker was unloaded through TTS-Story's cleanup endpoint, which reported zero allocated/reserved PyTorch GPU memory. Other desktop applications still occupied roughly 3 GB.

## Evaluation requirements

Use the application's current prompt composer and request adapter for compatibility tests. Label native-API diagnostics separately. Check source reconstruction (all words, case, punctuation and order), matching tags, alternating direction/speaker blocks, direction length, speaker ownership, attribution splits, alias resolution, and restrained narration. Valid tags alone are insufficient.

The test set includes the reporter's short passage and a roughly 450-word original scene with narration, multiple speakers, interrupted dialogue, an initially unnamed aunt later identified as Elin, and first-person narrator speech. Automated checks do not establish contextual correctness; inspect the tagged text too.

## Preliminary findings

- Qwen3.5 through the unchanged adapter: short passage preserved correctly in 34.78 seconds, but used 2,938 reasoning tokens out of 3,003 generated tokens. The longer sample hit the 4,096-token ceiling with no final content in 46.17 seconds.
- Qwen2.5: fast, but both the original V3 and compact prompts produced source/ownership errors. A smaller prompt recovered the expected cast but still omitted or altered prose. Do not recommend these outputs for production merely because they parse.
- Qwen3.5 with native API reasoning explicitly off: about 16 seconds for the longer sample, but source and speaker-ownership checks failed. This is a speed diagnostic, not a validated replacement workflow.
- Raising Qwen3.5's output ceiling to 12,288 yielded an answer after 99.91 seconds, including 8,197 reasoning tokens, but still produced mismatches and source errors. A larger ceiling alone did not solve accuracy.
- Splitting the longer sample with the application's existing 120-word soft limit did not repair Qwen2.5: three sections took 14.5 seconds total but altered a speaker name and omitted source text. Qwen3.5 exhausted an 8,192-token ceiling on the first section without returning an answer.
- Qwen3.5 native reasoning-off passed mechanical checks on a short dialogue in 5.62 seconds, but manual review found it split a narrative paragraph unnecessarily. A second test at a different temperature broke formatting. This is not sufficient evidence of dependable manuscript conversion.
- Gemma 3 12B Q4_K_M loaded with 8,192 context, 80% GPU offload, and one parallel request. LM Studio reported 7.59 GiB at load; observed total GPU usage during generation was 11,071 MiB including desktop applications. A 16K/full-offload estimate was 10.70 GiB before desktop overhead, so that configuration was not used.
- Gemma 3's minimal-prompt dialogue test took 136.16 seconds (1,204 output tokens, no reasoning). It left headings and the separator outside tags, omitted/rewrote some source, invented `i-male` for first-person narration, and misassigned interrupted dialogue. The test does not support a production recommendation.
- On the supplied public-domain *Chessmen of Mars* opening (through the narrator's first question to John Carter), Gemma 3 took 148.31 seconds with the compact prompt. It omitted the title/byline/headings, fragmented paragraphs into clauses, and misassigned dialogue. The existing V3 control took 82.95 seconds and improved tag structure/identity, but invented `CHAPTER I`, omitted `"You?"`, changed punctuation, and still split source paragraphs. Neither output passed fidelity review.

## Current pending work

A third experimental prompt, `local-llm-directed-insertion-test.txt`, emphasizes insertion-only editing and adds a complete miniature example with headings, an intact narrative paragraph, interrupted dialogue, and first-person speech. It remains unvalidated: Qwen2.5's 11.59-second dialogue result preserved headings but omitted speech and misclassified narration. Qwen3.5 through the current adapter took 124.67 seconds, exhausted 12,288 output tokens (8,197 reasoning), and returned an invalid/incomplete response. Native reasoning-off took 14.12 seconds with valid-looking structure but failed source fidelity and gender/ownership checks. Do not install any of these experiments as a production default.

The user paused/resumed Gemma 4's stalled download in LM Studio; it recovered and completed. No application restart was needed. Gemma 4 loaded at 8,192 context with full GPU offload; LM Studio reported 7.04 GiB at load, and observed total GPU usage during generation was 11,071 MiB including desktop applications.

Gemma 4's insertion-prompt dialogue test through the unchanged adapter took 61.25 seconds and exhausted the 4,096-token output limit with 4,093 reasoning tokens and no final manuscript. Native reasoning-off completed in 21.44 seconds and identified the expected cast, but inserted punctuation, omitted attributions, and mismatched direction closings. The original V3/book diagnostic took 50.22 seconds and repeated invented pause blocks until the 8K context filled (5,028 input plus 3,164 output tokens). This is a failed diagnostic, not a successful conversion.

All four models are now downloaded. None of the tested model/prompt combinations has demonstrated reliable manuscript preservation and speaker assignment on the longer fixtures. The experiments are useful starting points, not Gemini-equivalent replacements. A production-ready recommendation remains unproven; do not infer reliability from fast generation or matching tags alone.

Sampling parameters varied in exploratory tests; they are not all controlled head-to-head comparisons. Later adapter runs use temperature 0.2, top-p 0.95, top-k 20, repetition penalty 1.0, timeout 600 seconds, and a 4,096-token output ceiling unless the filename/settings say otherwise. Earlier requests used top-p 0.9 and some omitted the repetition setting. Native-API diagnostics must not be presented as application integration successes.

## Sources

- [Issue #38](https://github.com/Xerophayze/TTS-Story/issues/38)
- [Ollama thinking controls](https://docs.ollama.com/capabilities/thinking)
- [LM Studio native chat API](https://lmstudio.ai/docs/developer/rest/chat)
- [LM Studio model loading](https://lmstudio.ai/docs/developer/rest/load)
- [Qwen3.5 9B model card](https://huggingface.co/Qwen/Qwen3.5-9B)
- [Qwen3.5 LM Studio GGUF](https://huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF)
- [Qwen2.5 7B official GGUF](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF)
- [Gemma 3 model card](https://ai.google.dev/gemma/docs/core/model_card_3)
- [Gemma 3 12B LM Studio GGUF](https://huggingface.co/lmstudio-community/gemma-3-12b-it-GGUF)
- [Gemma 4 12B official model card](https://huggingface.co/google/gemma-4-12B-it)
- [Gemma 4 12B LM Studio GGUF](https://huggingface.co/lmstudio-community/gemma-4-12B-it-GGUF)
