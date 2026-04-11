import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Menu, X, Lock, LogIn, LogOut, User } from "lucide-react";
import { useAuth } from "@/lib/auth";

const navLinks = [
  { label: "Home", href: "/" },
  { label: "Projects", href: "/projects" },
  { label: "Members", href: "/members" },
  { label: "Editorials", href: "/editorials" },
  { label: "Generate", href: "/generate" },
  { label: "History", href: "/history" },
];

export function Navigation() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();
  const { authenticated, user, login, logout, isLoading } = useAuth();

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
          {navLinks.map((item) =>
            item.locked ? (
              <span
                key={item.href}
                className="flex items-center gap-1 text-muted-foreground/30 cursor-default select-none"
                data-testid={`link-nav-${item.label.toLowerCase()}`}
              >
                <Lock className="w-3 h-3" />
                {item.label}
              </span>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className={`hover:text-primary transition-colors pb-1 ${
                  location === item.href ? "text-foreground border-b-2 border-primary" : ""
                }`}
                data-testid={`link-nav-${item.label.toLowerCase()}`}
              >
                {item.label}
              </Link>
            )
          )}

          {!isLoading && (
            authenticated ? (
              <div className="flex items-center gap-3 ml-2 border-l border-border/30 pl-4">
                <span className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground/60">
                  <User className="w-3 h-3" />
                  {user?.displayName || user?.email || "Researcher"}
                </span>
                <button
                  onClick={logout}
                  className="flex items-center gap-1 text-xs font-mono text-muted-foreground/40 hover:text-foreground transition-colors"
                  data-testid="button-logout"
                >
                  <LogOut className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <button
                onClick={login}
                className="flex items-center gap-1.5 ml-2 border-l border-border/30 pl-4 text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
                data-testid="button-login"
              >
                <LogIn className="w-3.5 h-3.5" />
                Sign in
              </button>
            )
          )}
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
            {navLinks.map((item) =>
              item.locked ? (
                <span
                  key={item.href}
                  className="text-sm font-medium py-2 text-muted-foreground/30 flex items-center gap-1 select-none"
                  data-testid={`link-mobile-${item.label.toLowerCase()}`}
                >
                  <Lock className="w-3 h-3" />
                  {item.label}
                </span>
              ) : (
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
              )
            )}

            {!isLoading && (
              <div className="border-t border-border/30 pt-3 mt-1">
                {authenticated ? (
                  <button
                    onClick={logout}
                    className="flex items-center gap-2 text-sm font-medium py-2 text-muted-foreground"
                    data-testid="button-mobile-logout"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign out ({user?.displayName || user?.email || "Researcher"})
                  </button>
                ) : (
                  <button
                    onClick={login}
                    className="flex items-center gap-2 text-sm font-medium py-2 text-muted-foreground hover:text-primary transition-colors"
                    data-testid="button-mobile-login"
                  >
                    <LogIn className="w-4 h-4" />
                    Sign in with Future Science
                  </button>
                )}
              </div>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
