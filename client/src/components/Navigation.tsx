import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Menu, X, Lock, LogIn, LogOut, User, ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth";

const navLinks = [
  { label: "Home", href: "/" },
  { label: "Projects", href: "/projects" },
  { label: "Members", href: "/members" },
  { label: "Editorials", href: "/editorials" },
  { label: "Lab", href: "/generate" },
  { label: "History", href: "/history" },
];

export function Navigation() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();
  const { authenticated, user, login, logout, isLoading } = useAuth();

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ease-in-out ${
        scrolled
          ? "bg-background/85 backdrop-blur-xl border-b border-border/40 shadow-[0_1px_20px_rgba(0,0,0,0.3)] py-3"
          : "bg-transparent border-b border-transparent py-5"
      }`}
    >
      <div className="container mx-auto px-6 flex items-center gap-8">
        {/* Logo */}
        <Link href="/" data-testid="link-home" className="flex-shrink-0">
          <div className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <img
                src="/logo.png"
                alt="Machine Institute"
                className="h-8 w-8 object-contain transition-opacity duration-200 group-hover:opacity-80"
              />
            </div>
            <span className="font-heading font-bold text-base tracking-tight leading-none whitespace-nowrap">
              Machine<span className="text-primary/60 font-light">Institute</span>
            </span>
          </div>
        </Link>

        {/* Divider */}
        <div className="hidden md:block h-5 w-px bg-border/40 flex-shrink-0" />

        {/* Desktop nav links */}
        <nav className="hidden md:flex items-center gap-1 flex-1">
          {navLinks.map((item) =>
            item.locked ? (
              <span
                key={item.href}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground/25 cursor-default select-none rounded-md"
                data-testid={`link-nav-${item.label.toLowerCase()}`}
              >
                <Lock className="w-3 h-3" />
                {item.label}
              </span>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className={`relative px-3 py-1.5 text-sm rounded-md transition-all duration-200 whitespace-nowrap ${
                  location === item.href
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5 font-normal"
                }`}
                data-testid={`link-nav-${item.label.toLowerCase()}`}
              >
                {item.label}
                {location === item.href && (
                  <span className="absolute inset-x-3 -bottom-px h-px bg-primary rounded-full" />
                )}
              </Link>
            )
          )}
        </nav>

        {/* Auth area */}
        <div className="hidden md:flex items-center flex-shrink-0 ml-auto">
          {!isLoading && (
            authenticated ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-white/5 border border-border/30">
                  <User className="w-3 h-3 text-muted-foreground/60 flex-shrink-0" />
                  <span className="text-xs font-mono text-muted-foreground/70 max-w-[140px] truncate">
                    {user?.displayName || user?.email || "Researcher"}
                  </span>
                </div>
                <button
                  onClick={logout}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono text-muted-foreground/50 hover:text-foreground hover:bg-white/5 transition-all duration-200"
                  data-testid="button-logout"
                  title="Sign out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign out</span>
                </button>
              </div>
            ) : (
              <button
                onClick={login}
                className="flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 hover:border-primary/40 transition-all duration-200 whitespace-nowrap"
                data-testid="button-login"
              >
                <LogIn className="w-3.5 h-3.5 flex-shrink-0" />
                Sign in
              </button>
            )
          )}
        </div>

        {/* Mobile menu toggle */}
        <button
          className="md:hidden ml-auto flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all duration-200"
          onClick={() => setMobileOpen(!mobileOpen)}
          data-testid="button-mobile-menu"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      <div
        className={`md:hidden overflow-hidden transition-all duration-300 ease-in-out ${
          mobileOpen ? "max-h-[600px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="bg-background/95 backdrop-blur-xl border-t border-border/30">
          <nav className="container mx-auto px-4 py-3 flex flex-col">
            {navLinks.map((item) =>
              item.locked ? (
                <span
                  key={item.href}
                  className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground/25 select-none rounded-md"
                  data-testid={`link-mobile-${item.label.toLowerCase()}`}
                >
                  <Lock className="w-3.5 h-3.5" />
                  {item.label}
                </span>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center justify-between px-3 py-2.5 text-sm rounded-md transition-all duration-150 ${
                    location === item.href
                      ? "text-foreground font-medium bg-white/5 border-l-2 border-primary pl-[10px]"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5 font-normal"
                  }`}
                  data-testid={`link-mobile-${item.label.toLowerCase()}`}
                >
                  {item.label}
                  {location === item.href && (
                    <ChevronRight className="w-3.5 h-3.5 text-primary" />
                  )}
                </Link>
              )
            )}

            {!isLoading && (
              <div className="mt-2 pt-3 border-t border-border/30">
                {authenticated ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-white/5">
                      <User className="w-3.5 h-3.5 text-muted-foreground/60" />
                      <span className="text-xs font-mono text-muted-foreground/60 truncate">
                        {user?.displayName || user?.email || "Researcher"}
                      </span>
                    </div>
                    <button
                      onClick={logout}
                      className="flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 rounded-md transition-all duration-150"
                      data-testid="button-mobile-logout"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign out
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={login}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-sm font-medium rounded-md bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 transition-all duration-150"
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
      </div>
    </header>
  );
}
