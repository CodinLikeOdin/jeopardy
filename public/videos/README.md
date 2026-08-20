# Lobby videos

Drop video files here (`.mp4` or `.webm`) and they'll appear in the host's
**🎬 Lobby Video** dropdown on the setup screen, to play in the lobby while
contestants wait.

## How to add a video (no coding needed)
1. Go to this folder on GitHub: `CodinLikeOdin/jeopardy` → `public/videos`
2. **Add file → Upload files** → drag your `.mp4`/`.webm` in → **Commit changes**
3. Render redeploys automatically (~2 min). The file then shows up in the dropdown.

## Notes
- Keep files reasonably small (a few minutes / tens of MB) — they're committed to the repo.
- Switching which video a game uses is instant (just pick another from the dropdown);
  only *adding* a new file triggers a redeploy.
- The lobby autoplays muted + looping (browser autoplay rules); contestants can tap to unmute.
- **Loudness:** files uploaded directly via the GitHub web UI are used as-is — they are
  NOT automatically loudness-normalized. If you want a new clip to match the volume of
  the other clips (intro video, think-music — both mixed to -16 LUFS), hand the source
  file to a Claude session instead of uploading it yourself, and ask it to normalize
  before committing (`ffmpeg -af loudnorm=I=-16:TP=-1.5:LRA=11`).
