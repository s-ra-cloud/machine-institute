import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Menu, X } from "lucide-react";

const navLinks = [
  { label: "Home", href: "/" },
  { label: "Projects", href: "/projects" },
  { label: "Members", href: "/members" },
  { label: "Editorials", href: "/editorials" },
  { label: "History", href: "/history" },
];

export function Navigation() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 border-b border-transparent ${
        scrolled ? "bg-background/80 backdrop-blur-md border-border/50 py-3" : "bg-transparent py-5"
      }`}
    >
      <div className="container mx-auto px-6 flex items-center justify-between">
        <Link href="/" data-testid="link-home">
          <div className="flex items-center gap-2 cursor-pointer">
            <img src="/logo.png" alt="Machine Institute" className="h-8 w-8 object-contain" />
            <span className="font-heading font-bold text-lg tracking-tight">
              Machine<span className="text-muted-foreground font-light">Institute</span>
            </span>
          </div>
        </Link>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground">
          {navLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`hover:text-foreground transition-colors pb-1 ${
                location === item.href ? "text-primary border-b-2 border-primary" : ""
              }`}
              data-testid={`link-nav-${item.label.toLowerCase()}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <button
          className="md:hidden text-foreground"
          onClick={() => setMobileOpen(!mobileOpen)}
          data-testid="button-mobile-menu"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="md:hidden bg-background/95 backdrop-blur-md border-t border-border/50">
          <nav className="container mx-auto px-6 py-4 flex flex-col gap-3">
            {navLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`text-sm font-medium py-2 transition-colors ${
                  location === item.href ? "text-foreground" : "text-muted-foreground"
                }`}
                data-testid={`link-mobile-${item.label.toLowerCase()}`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}