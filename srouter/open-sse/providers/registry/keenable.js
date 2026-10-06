export default {
  id: "keenable",
  alias: "keenable",
  display: {
    name: "Keenable",
    icon: "search",
    color: "#005CFF",
    textIcon: "KE",
    website: "https://keenable.ai",
    notice: {
      text: "Independent web index: search returns ranked results with descriptions and fetch returns clean page Markdown. API keys use the X-API-Key header; keyless endpoints are rate-limited."
    }
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  serviceKinds: ["webSearch"]
};
