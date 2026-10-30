import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"

export default defineConfig({
  site: "https://jpowersdev.github.io",
  base: "/effect-agent",
  integrations: [
    starlight({
      title: "effect-agent",
      description:
        "Effect-native control of Claude Code and Codex: live sessions, steering, typed endings, reattach.",
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      // Code fits the content column from 1440px up; narrower screens wrap it
      expressiveCode: { defaultProps: { wrap: true } },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/jpowersdev/effect-agent" }],
      editLink: { baseUrl: "https://github.com/jpowersdev/effect-agent/edit/main/site/" },
      sidebar: [
        { label: "Getting started", slug: "getting-started" },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        {
          label: "API reference",
          items: [
            { label: "effect-agent", items: [{ autogenerate: { directory: "api/core" } }] },
            { label: "effect-agent/claude", items: [{ autogenerate: { directory: "api/claude" } }] },
            { label: "effect-agent/codex", items: [{ autogenerate: { directory: "api/codex" } }] },
            { label: "effect-agent/host", items: [{ autogenerate: { directory: "api/host" } }] },
          ],
        },
      ],
    }),
  ],
})
