"use client";
import { useRouter } from "next/navigation";
import Navigation from "./components/Navigation";
import HeroSection from "./components/HeroSection";
import FlowAnimation from "./components/FlowAnimation";
import HowItWorks from "./components/HowItWorks";
import Features from "./components/Features";
import GetStarted from "./components/GetStarted";
import Footer from "./components/Footer";
import IsoCubeBackground from "./components/IsoCubeBackground";

export default function LandingPage() {
  const router = useRouter();
  return (
    <div className="relative text-white font-sans overflow-x-hidden antialiased selection:bg-[#6366f1] selection:text-white">
      {/* Static background: Iso Cube Field baked once behind all content */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none bg-[#0B0C15] bg-app-gradient-dark">
        <IsoCubeBackground />

        {/* Vignette effect */}
        <div className="absolute inset-0" style={{
          background: 'radial-gradient(circle at center, transparent 0%, rgba(11, 12, 21, 0.45) 100%)'
        }}></div>
      </div>

      <div className="relative z-10">
        <Navigation />
        
        <main>
          {/* Hero with Flow Animation */}
          <div className="relative">
          <HeroSection />
          <div className="flex justify-center pb-20">
            <FlowAnimation />
          </div>
        </div>
        
        <GetStarted />
        <HowItWorks />
        <Features />
        
        {/* CTA Section */}
        <section className="py-32 px-6 relative overflow-hidden">
          <div className="absolute inset-0 bg-linear-to-t from-[#6366f1]/10 to-transparent pointer-events-none"></div>
          <div className="max-w-4xl mx-auto text-center relative z-10">
            <h2 className="text-4xl md:text-5xl font-black mb-6">Ready to Simplify Your AI Infrastructure?</h2>
            <p className="text-xl text-gray-400 mb-10 max-w-2xl mx-auto">
              Join developers who are streamlining their AI integrations with Srouter. Open source and free to start.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <button 
                onClick={() => router.push("/dashboard")}
                className="w-full sm:w-auto h-14 px-10 rounded-lg bg-gradient-brand hover:brightness-110 text-white text-lg font-bold transition-all shadow-[0_0_20px_rgba(99,102,241,0.5)]"
              >
                Start Free
              </button>
              <button 
                onClick={() => window.open("https://github.com/decolua/9router#readme", "_blank")}
                className="w-full sm:w-auto h-14 px-10 rounded-lg border border-[#2A2C45] hover:bg-[#141526] text-white text-lg font-bold transition-all"
              >
                Read Documentation
              </button>
            </div>
          </div>
        </section>
        </main>
        
        <Footer />
      </div>
      
      {/* Global styles for keyframes */}
      <style jsx global>{`
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        @keyframes dash {
          to { stroke-dashoffset: -20; }
        }
      `}</style>
    </div>
  );
}

