import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { startMarkdocExtension } from "./extension-core.mjs";

await startMarkdocExtension({ createCanvas, joinSession });
