import { Navigation } from "@/components/Navigation";
import { Hero } from "@/components/Hero";
import { ResearchFocus } from "@/components/ResearchFocus";
import { FeaturedProjects } from "@/components/FeaturedProjects";
import { Publications } from "@/components/Publications";
import { People } from "@/components/People";
import { Collaborate } from "@/components/Collaborate";
import { Footer } from "@/components/Footer";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground relative">
      <Navigation />
      <main>
        <Hero />
        <ResearchFocus />
        <FeaturedProjects />
        <Publications />
        <People />
        <Collaborate />
      </main>
      <Footer />
    </div>
  );
}