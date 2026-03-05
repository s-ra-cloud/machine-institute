import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { XFeedPanel } from "@/components/XFeedPanel";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Projects from "@/pages/Projects";
import ProjectDetail from "@/pages/ProjectDetail";
import Members from "@/pages/Members";
import Editorials from "@/pages/Editorials";
import EditorialDetail from "@/pages/EditorialDetail";
import History from "@/pages/History";
import PaperDetail from "@/pages/PaperDetail";

function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);
  return null;
}

function Router() {
  return (
    <>
      <ScrollToTop />
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/projects" component={Projects} />
        <Route path="/projects/:id" component={ProjectDetail} />
        <Route path="/members" component={Members} />
        <Route path="/editorials" component={Editorials} />
        <Route path="/editorials/:slug" component={EditorialDetail} />
        <Route path="/history" component={History} />
        <Route path="/papers/:slug" component={PaperDetail} />
        <Route component={NotFound} />
      </Switch>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <XFeedPanel />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;