import { copyFile } from "node:fs/promises";

await Promise.all([
  copyFile("LICENSE", "ui-dist/LICENSE"),
  copyFile("NOTICE", "ui-dist/NOTICE"),
  copyFile("TRADEMARKS.md", "ui-dist/TRADEMARKS.md"),
  copyFile("THIRD_PARTY_NOTICES.md", "ui-dist/THIRD_PARTY_NOTICES.md"),
]);
