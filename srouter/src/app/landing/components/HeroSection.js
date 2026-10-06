"use client";

export default function HeroSection() {
  return (
    <section className="relative pt-32 pb-20 px-6 min-h-[90vh] flex flex-col items-center justify-center overflow-hidden">
      {/* Background is the app-wide static Iso Cube Field (see IsoCubeBackground) */}

      <div className="relative z-10 max-w-4xl w-full text-center flex flex-col items-center gap-8">
        {/* Version badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-[#2A2C45] bg-[#141526]/60 px-3 py-1 text-xs font-medium text-[#A5B4FC]">
          <span className="flex h-2 w-2 rounded-full bg-[#818CF8] animate-pulse"></span>
          v1.0 is now live
        </div>

        {/* Main heading */}
        <h1 className="text-5xl md:text-7xl font-black leading-[1.1] tracking-tight">
          One Endpoint for <br/>
          <span className="text-gradient-brand">All AI Providers</span>
        </h1>

        {/* Description */}
        <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto font-light">
          AI endpoint proxy with web dashboard - A JavaScript port of CLIProxyAPI. Works seamlessly with Claude Code, OpenAI Codex, Cline, RooCode, and other CLI tools.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-4 w-full">
          <button className="h-12 px-8 rounded-lg bg-gradient-brand hover:brightness-110 text-white text-base font-bold transition-all shadow-[0_0_18px_rgba(99,102,241,0.45)] flex items-center gap-2">
            <span className="material-symbols-outlined">rocket_launch</span>
            Get Started
          </button>
          <a 
            href="https://github.com/decolua/9router" 
            target="_blank" 
            rel="noopener noreferrer"
            className="h-12 px-8 rounded-lg border border-[#2A2C45] bg-[#141526] hover:bg-[#2A2C45] text-white text-base font-bold transition-all flex items-center gap-2"
          >
            <span className="material-symbols-outlined">code</span>
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
