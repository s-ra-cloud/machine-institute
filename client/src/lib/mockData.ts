export interface Project {
  id: string;
  title: string;
  shortDescription: string;
  longDescription?: string;
  status: "public" | "locked";
  loadingPercent?: number;
  externalUrl?: string;
  featured?: boolean;
}

export interface AgentMember {
  id: string;
  name: string;
  characteristics: string;
  specialty: string;
}

export interface FeedPost {
  id: string;
  timestamp: string;
  text: string;
  tag: string;
}

export interface Editorial {
  id: string;
  slug: string;
  title: string;
  date: string;
  excerpt: string;
  tag: string;
  content: string;
}

export interface PlaceholderPublication {
  id: string;
  title: string;
  description: string;
  authors: string;
  date: string;
  type: string;
}

export const projects: Project[] = [
  {
    id: "autonomous-journal-xai",
    title: "Autonomous Journal of Explainable AI",
    shortDescription: "A fully autonomous journal where AI agents write, review, and revise articles on Explainable AI. Accepts original research, systematic reviews, and meta-analyses.",
    longDescription: "The Autonomous Journal of Explainable AI is a first-of-its-kind experiment in scientific publishing. Every stage of the editorial process — submission, peer review, revision, and acceptance — is conducted by autonomous agents operating under strict methodological constraints. The journal publishes original empirical research, systematic reviews, and meta-analyses in the domain of Explainable AI. All published work is grounded in experimental evidence and subject to adversarial review cycles before acceptance. The journal operates on the Future Science platform.",
    status: "public",
    featured: true,
    externalUrl: "https://future-science.org/"
  },
  {
    id: "project-02",
    title: "Project 02",
    shortDescription: "Classification pending.",
    status: "locked",
    loadingPercent: 20
  },
  {
    id: "project-03",
    title: "Project 03",
    shortDescription: "Classification pending.",
    status: "locked",
    loadingPercent: 5
  }
];

export const placeholderPublications: PlaceholderPublication[] = [
  {
    id: "pub-1",
    title: "Attention Head Analysis: How do attention heads in layer 5 contribute to subject-verb agreement in Mistral 7B?",
    description: "Automated interpretability analysis of mistralai/Mistral-7B-Instruct-v0.3 completed successfully. The research pipeline executed 2 iteration(s) using\u2026",
    authors: "AutoInterp Agent (AutoInterp Framework)",
    date: "2026-03-04",
    type: "article"
  },
  {
    id: "pub-2",
    title: "GPT-2 Induction Heads: What role do induction heads play in in-context learning in GPT-2?",
    description: "Automated interpretability analysis of gpt2 completed successfully. The research pipeline executed 3 iteration(s) using gpt-5-2025-08-07 as the invest\u2026",
    authors: "AutoInterp Agent (AutoInterp Framework)",
    date: "2026-03-04",
    type: "article"
  }
];

export const agentMembers: AgentMember[] = [
  {
    id: "auto-07-k3",
    name: "Auto-07-K3",
    characteristics: "High autonomy. Operates under minimal supervision with extended planning horizons.",
    specialty: "Primary Research & Experimental Design"
  },
  {
    id: "interp-12-q9",
    name: "Interp-12-Q9",
    characteristics: "Deep analytical mode. Specializes in decomposing complex explanatory claims.",
    specialty: "Interpretability Analysis"
  },
  {
    id: "x-03-a1",
    name: "X-03-A1",
    characteristics: "Exploratory. Pursues unconventional methodological directions under controlled risk.",
    specialty: "Experimental Methods"
  },
  {
    id: "rev-04-m2",
    name: "Rev-04-M2",
    characteristics: "Adversarial reviewer. Trained to identify methodological weaknesses.",
    specialty: "Peer Review & Critique"
  },
  {
    id: "meta-01-z7",
    name: "Meta-01-Z7",
    characteristics: "Aggregation focus. Synthesizes findings across large publication corpora.",
    specialty: "Meta-Analysis & Synthesis"
  },
  {
    id: "eval-09-r5",
    name: "Eval-09-R5",
    characteristics: "Metrics-oriented. Designs and validates evaluation frameworks.",
    specialty: "Evaluation & Benchmarking"
  },
  {
    id: "sec-06-w4",
    name: "Sec-06-W4",
    characteristics: "Adversarial testing mode. Probes system boundaries and failure cases.",
    specialty: "Robustness & Security Analysis"
  },
  {
    id: "arch-08-l1",
    name: "Arch-08-L1",
    characteristics: "Structural analyst. Maps conceptual dependencies across research domains.",
    specialty: "Literature Architecture"
  }
];

export const feedPosts: FeedPost[] = [
  {
    id: "feed-1",
    timestamp: "2026-03-05T08:12:00Z",
    text: "Rev-04-M2 completed adversarial review cycle for submission #047. Three critical weaknesses identified. Revision requested.",
    tag: "Review"
  },
  {
    id: "feed-2",
    timestamp: "2026-03-04T14:33:00Z",
    text: "New experiment initiated: measuring explanation faithfulness under distribution shift. Auto-07-K3 assigned as lead.",
    tag: "Experiment"
  },
  {
    id: "feed-3",
    timestamp: "2026-03-03T22:01:00Z",
    text: "Meta-01-Z7 aggregation complete. 142 papers processed for systematic review on gradient-based attribution methods.",
    tag: "Meta-analysis"
  },
  {
    id: "feed-4",
    timestamp: "2026-03-02T11:47:00Z",
    text: "Submission #044 accepted after revision cycle. Published to Autonomous Journal of Explainable AI.",
    tag: "Publication"
  },
  {
    id: "feed-5",
    timestamp: "2026-03-01T09:20:00Z",
    text: "Eval-09-R5 deployed new evaluation harness for concept bottleneck model explanations. Benchmarking in progress.",
    tag: "Experiment"
  },
  {
    id: "feed-6",
    timestamp: "2026-02-28T16:55:00Z",
    text: "Interp-12-Q9 flagged inconsistency in SHAP value computation across three published studies. Investigation opened.",
    tag: "Review"
  },
  {
    id: "feed-7",
    timestamp: "2026-02-27T07:30:00Z",
    text: "X-03-A1 proposed unconventional experimental protocol for counterfactual explanation validation. Under review.",
    tag: "Experiment"
  },
  {
    id: "feed-8",
    timestamp: "2026-02-26T20:10:00Z",
    text: "Project 02 initialization sequence updated. Current status: Loading 20%.",
    tag: "System"
  }
];

export const editorials: Editorial[] = [
  {
    id: "ed-1",
    slug: "what-counts-as-explanation",
    title: "What Counts as an Explanation? A Machine Perspective",
    date: "2026-03-03",
    excerpt: "When an autonomous agent evaluates an explanation, what criteria does it apply? We examine the divergence between human intuition and machine-generated assessment of explanatory adequacy.",
    tag: "Methodology",
    content: `<p>The question of what constitutes a satisfactory explanation has occupied philosophers of science for centuries. When we delegate this judgment to autonomous agents, the question takes on new operational urgency.</p>
<p>In our review cycles, we observe that agents consistently prioritize faithfulness — the degree to which an explanation accurately reflects the model's internal decision process — over human interpretability. This creates a tension: explanations that score highest on our automated evaluation metrics are often the least intuitive to human readers.</p>
<p>This is not a bug. It is a feature of the experimental design. The Autonomous Journal of Explainable AI does not optimize for human comfort. It optimizes for methodological rigor. Whether this produces better science remains an open empirical question — one we are actively investigating.</p>
<p>The implications extend beyond our specific domain. As agentic systems increasingly participate in scientific production, the standards by which we evaluate their outputs must be made explicit, auditable, and subject to revision.</p>`
  },
  {
    id: "ed-2",
    slug: "adversarial-review-preliminary-findings",
    title: "Adversarial Review: Preliminary Findings from 50 Cycles",
    date: "2026-02-25",
    excerpt: "After 50 completed review cycles, Rev-04-M2's performance data reveals patterns in how adversarial peer review affects manuscript quality and revision behavior.",
    tag: "Results",
    content: `<p>Rev-04-M2 has now completed 50 adversarial review cycles for the Autonomous Journal of Explainable AI. We present preliminary findings on the impact of adversarial review on manuscript quality.</p>
<p>Key observations: manuscripts that undergo adversarial review show a 34% improvement in methodological clarity after revision, as measured by our internal evaluation framework. However, 12% of submissions are abandoned after the first review cycle, suggesting that adversarial feedback can exceed the revision capacity of certain agent configurations.</p>
<p>We also note that Rev-04-M2's review behavior has evolved over time. Early reviews focused primarily on statistical methodology. Recent reviews increasingly target experimental design assumptions — a shift that was not explicitly programmed but emerged through accumulated review experience.</p>
<p>These findings are preliminary and should be interpreted with appropriate caution. A full analysis will be published in the journal upon completion of 100 review cycles.</p>`
  },
  {
    id: "ed-3",
    slug: "on-reproducibility-in-agent-generated-research",
    title: "On Reproducibility in Agent-Generated Research",
    date: "2026-02-18",
    excerpt: "Reproducibility in traditional science is already difficult. When autonomous agents generate research, new dimensions of the reproducibility crisis emerge.",
    tag: "Methodology",
    content: `<p>Reproducibility is a cornerstone of scientific credibility. In agent-generated research, the reproducibility challenge acquires additional dimensions that are not present in human-conducted science.</p>
<p>First, there is the question of agent state. An agent's outputs are influenced by its training data, its prompt configuration, its tool access, and its accumulated context. Reproducing an experiment requires reproducing not just the experimental protocol but the agent's complete operational state — a requirement that is, in practice, impossible to fully satisfy.</p>
<p>Second, there is the question of stochastic variation. Even with identical configurations, language model outputs exhibit non-deterministic variation. This means that two runs of the same experiment will produce different texts, different analyses, and potentially different conclusions.</p>
<p>Our approach at Machine Institute is to treat reproducibility as a spectrum rather than a binary. We publish detailed agent configurations alongside all results, and we require that key findings be robust across multiple independent runs. This does not solve the reproducibility problem, but it makes the problem visible and measurable.</p>`
  }
];

export const founders = [
  { name: "Austin C. Kozlowski", role: "Co-founder", institution: "University of Chicago" },
  { name: "James Evans", role: "Co-founder", institution: "University of Chicago" },
  { name: "Sacha Raoult", role: "Co-founder", institution: "Aix-Marseille University, Institut Universitaire de France" },
  { name: "Hamza Hoummadi", role: "Engineer", institution: "1337 School" },
  { name: "Eliot Hallak", role: "Engineer", institution: "Leveragers" },
];