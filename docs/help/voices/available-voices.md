# Voice Management Overview

Open [Voices](app:voices) to maintain reusable voices before assigning them on Generate. The screen has five sub-tabs; most show how many items they hold:

1. **Voice prompts** for uploaded or generated reference clips used by cloning engines.
2. **Kokoro** for built-in voice previews, grouped by language.
3. **Kokoro blends** for weighted combinations of compatible Kokoro voices.
4. **Voice creation** for designing a sample with Qwen3-TTS, Breeze TTS 2, or OmniVoice.
5. **Gemini cloud voices** for designed voices hosted in your Google project.

TTS-Story remembers the last sub-tab you opened during the session.

![Voices screen with the Kokoro voice catalog and preview controls](../../../static/help/screenshots/kokoro-voice-browser.png)

*Voices groups built-in catalogs, custom blends, designed voices, and reusable reference prompts in one workspace.*

These voice types are not interchangeable. A Kokoro voice code is selected from a built-in list, while a cloning engine expects a reference audio file. Qwen3, Breeze, and OmniVoice design create audio that is then saved into the same reference-prompt library.

## Built-in voices

Kokoro, Pocket TTS Preset, Qwen3 Custom Voice, KittenTTS, Azure Speech, Edge TTS, and ElevenLabs use provider/model voice catalogs rather than a local reference recording. Their available voice lists depend on the selected engine and, for online providers, the configured account or live service catalog.

Kokoro previews are managed on the **Kokoro** sub-tab of Voices. See [Kokoro Voices and Previews](help:kokoro-voices).

## Reference prompts

Chatterbox, VoxCPM, Pocket TTS Clone, Qwen3 Clone, OmniVoice Clone, IndexTTS, and Dot.TTS can use saved reference audio. The engine may impose additional language, duration, transcript, or hardware requirements.

The **Voice prompts** sub-tab supports uploading, bulk importing, previewing, metadata editing, exporting, archiving, restoring, and deleting clips. There is no microphone recording control in the current interface; record and edit the clip in another application, then upload it. See [Reference Voice Prompts](help:voice-prompts).

## Designed voices

Qwen3-TTS, Breeze TTS 2, and OmniVoice can synthesize a voice from written characteristics. Generate a preview, listen to it, and save an acceptable result to voice prompts. Saved output becomes a reference clip; the design mode itself is not selected as a normal narration engine on Generate.

See [Create Voices with Qwen3, Breeze, or OmniVoice](help:voice-creation).

## Local and external prompt libraries

The prompt table combines local clips with external voices loaded from GitHub. **Load external voices** requires internet access. External voices show an **External** pill; preview one with its play button, then use its download icon (or **Download** in the row's **More actions** menu) to add a local copy that engines can use. Previewing alone does not add the voice to your prompts.

Use filters for name, source, gender, and language. Gender and language are organizational metadata and do not transform the audio.

**Archive** hides voices from the active list and from speaker pickers without deleting their files; archived voices appear in the collapsible **Archived voices** card below the table. **Unarchive** restores them. **Delete** is permanent, and an existing Project or Library item can retain a path to a voice that no longer exists. Export important clips before deletion.

## Assign voices to a manuscript

Return to [Generate](app:generate), analyze the text, and click a speaker chip. Select a compatible built-in voice or prompt, then use **Quick Test**. Assignment is per detected speaker and per selected job engine.

For the complete workflow, see [Assign and Test Voices](help:assign-voices) and [Generate and Auto-Assign Voices](help:auto-assign-voices).
