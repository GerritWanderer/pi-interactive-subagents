/** No-model fixture: exercise Pi's own components and OSC reporter, never emit status here. */
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, Markdown, Image, getCapabilities, rgbColor } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// A red/blue checkerboard PNG. No image library, network request, or model is needed.
const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGN4pqHxHx/WCHiGFzOMGjAsDCCkgJAFowYMCwMAuB1JH3qLuOwAAAAASUVORK5CYII=";

export default function nativePiSmoke(pi: ExtensionAPI) {
  // Detect accidental model-request attempts; the tests invoke only known slash commands.
  pi.on("before_provider_request", (_event, ctx) => {
    writeFileSync(join(ctx.cwd, "unexpected-provider-request"), "blocked");
    throw new Error("Native smoke must not call a model");
  });
  pi.on("input", (event) => event.text.startsWith("/") ? undefined : { action: "handled" as const });
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) throw new Error("Native smoke requires Pi's interactive TUI");
    writeFileSync(join(ctx.cwd, "native-state.json"), JSON.stringify({
      capabilities: getCapabilities(),
      termProgram: process.env.TERM_PROGRAM,
      programStatus: process.env.PI_PROGRAM_STATUS ?? null,
      tools: pi.getAllTools().map((tool) => tool.name),
    }));
    // These are Pi's native components, not another renderer or protocol emitter.
    ctx.ui.setWidget("native-smoke", (_tui, theme) => {
      const container = new Container();
      container.addChild(new Markdown("[NATIVE_REX_LINK](https://www.superlogical.com/rex)", 0, 0, getMarkdownTheme()));
      container.addChild(new Text(theme.style("NATIVE_REX_COLOR", { fg: rgbColor(18, 52, 86) }), 0, 0));
      container.addChild(new Image(png, "image/png", { fallbackColor: (text) => text }, { maxWidthCells: 8 }));
      return container;
    });
  });
  pi.registerCommand("native-smoke-dialog", {
    description: "Open a real Pi dialog to observe native blocked status",
    handler: async (_args, ctx) => { await ctx.ui.confirm("Native smoke permission", "No action will be performed."); },
  });
}
