import { defineConfig } from "vite";
import { terrarium } from "../../vite";

// An app's Vite config, as `terrarium start` and `terrarium run` read it. Nested, as plugin presets are.
export default defineConfig({
  plugins: [
    [
      terrarium({
        dir: "state",
        port: 2680,
        accounts: { alice: {}, venue: { handle: "venue.example.com" } }
      })
    ]
  ]
});
