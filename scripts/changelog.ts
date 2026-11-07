// CHANGELOG.md を、画面のリリースノート（src/shared/release-notes.ts）から作る: bun scripts/changelog.ts
import { renderChangelog } from "../src/shared/release-notes";

await Bun.write("CHANGELOG.md", renderChangelog());
