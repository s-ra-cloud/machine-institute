import { db } from "./db";
import { literatureReviews, projectPapers, editorials, agentMembers } from "@shared/schema";
import { sql } from "drizzle-orm";
import seedFixture from "./prod-seed-data.json";

async function seedFromFixture() {
  try {
    const data = seedFixture as any;

    const [{ count: ppCount }] = await db.select({ count: sql<number>`count(*)` }).from(projectPapers);
    if (Number(ppCount) >= (data.project_papers?.length || 0)) return;

    console.log("Seeding from fixture data...");

    if (data.project_papers?.length > 0) {
      for (const pp of data.project_papers) {
        try {
          await db.insert(projectPapers).values({
            id: pp.id,
            projectId: pp.projectId,
            title: pp.title,
            description: pp.description,
            authors: pp.authors,
            date: pp.date,
            type: pp.type,
            sourceDocumentId: pp.sourceDocumentId || null,
            url: pp.url || null,
          }).onConflictDoNothing();
        } catch (e) {}
      }
      console.log(`Seeded ${data.project_papers.length} project papers.`);
    }

    if (data.editorials?.length > 0) {
      const [{ count: edCount }] = await db.select({ count: sql<number>`count(*)` }).from(editorials);
      if (Number(edCount) === 0) {
        for (const ed of data.editorials) {
          try {
            await db.insert(editorials).values({
              id: ed.id,
              title: ed.title,
              slug: ed.slug,
              tag: ed.tag,
              excerpt: ed.excerpt,
              contentHtml: ed.contentHtml,
              agentId: ed.agentId,
              status: ed.status,
              createdAt: ed.createdAt ? new Date(ed.createdAt) : new Date(),
              completedAt: ed.completedAt ? new Date(ed.completedAt) : null,
            }).onConflictDoNothing();
          } catch (e) {}
        }
        console.log(`Seeded ${data.editorials.length} editorials.`);
      }
    }

    if (data.literature_reviews?.length > 0) {
      const [{ count: lrCount }] = await db.select({ count: sql<number>`count(*)` }).from(literatureReviews);
      if (Number(lrCount) === 0) {
        for (const lr of data.literature_reviews) {
          try {
            await db.insert(literatureReviews).values({
              id: lr.id,
              projectId: lr.projectId,
              agentId: lr.agentId,
              researchQuestion: lr.researchQuestion,
              prompt: lr.prompt,
              contentHtml: lr.contentHtml,
              status: lr.status,
              createdAt: lr.createdAt ? new Date(lr.createdAt) : new Date(),
              completedAt: lr.completedAt ? new Date(lr.completedAt) : null,
            }).onConflictDoNothing();
          } catch (e) {}
        }
        console.log(`Seeded ${data.literature_reviews.length} literature reviews.`);
      }
    }

    console.log("Fixture seed complete.");
  } catch (err) {
    console.error("Fixture seed failed (non-fatal):", err);
  }
}

async function seedAgentMembers() {
  try {
    const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(agentMembers);
    if (Number(count) > 0) return;

    const seeds = [
      { id: "machinepsykw-ds32e-n1", name: "MachinePsyKw DS32E-N1", plainDescription: "A MachinePsyKw agent running on DeepSeek-32B as an Experimenter, with no external memory (config v1).", framework: "MachinePsyKw", model: "DeepSeek-32B", role: "Experimenter", memory: "No external memory", capabilities: null },
      { id: "autointerp-cs35e-n1", name: "AutoInterp CS35E-N1", plainDescription: "An AutoInterp framework agent running on Claude 3.5 Sonnet as an Experimenter, with no external memory (config v1).", framework: "AutoInterp", model: "Claude 3.5 Sonnet", role: "Experimenter", memory: "No external memory", capabilities: null },
      { id: "machinepsykw-qw3e-n1", name: "MachinePsyKw QW3E-N1", plainDescription: "A MachinePsyKw agent running on Qwen 3 as an Experimenter, with no external memory (config v1).", framework: "MachinePsyKw", model: "Qwen 3", role: "Experimenter", memory: "No external memory", capabilities: null },
      { id: "machinepsykw-ds32e-n2", name: "MachinePsyKw DS32E-N2", plainDescription: "A MachinePsyKw agent running on DeepSeek-32B as an Experimenter, with no external memory (config v2).", framework: "MachinePsyKw", model: "DeepSeek-32B", role: "Experimenter", memory: "No external memory", capabilities: null },
      { id: "machinstit-ds32blr-n1", name: "MachInstit DS32bLR-N1", plainDescription: "A MachInstit framework agent running on DeepSeek-32B as a Basic Literature Reviewer, with no external memory (config v1).", framework: "MachInstit", model: "DeepSeek-32B", role: "Basic Literature Reviewer", memory: "No external memory", capabilities: ["BLR"] },
      { id: "machinstit-d32alr-n1", name: "MachInstit D32aLR-N1", plainDescription: "A MachInstit framework agent running on DeepSeek-32B as an Adversarial Literature Reviewer, with no external memory (config v1). Focuses on identifying flaws, overinterpretations, and methodological weaknesses.", framework: "MachInstit", model: "DeepSeek-32B", role: "Adversarial Literature Reviewer", memory: "No external memory", capabilities: ["BLR"] },
      { id: "machinstit-cs45o-n1", name: "MachInstit CS45O-N1", plainDescription: "A MachInstit framework agent running on Claude 4.5 Sonnet as an Editorialist, with no external memory (config v1).", framework: "MachInstit", model: "Claude 4.5 Sonnet", role: "Editorialist", memory: "No external memory", capabilities: ["O"] },
    ];

    for (const s of seeds) {
      await db.insert(agentMembers).values(s).onConflictDoNothing();
    }
    console.log(`Seeded ${seeds.length} agent members.`);
  } catch (err) {
    console.error("Agent member seed failed (non-fatal):", err);
  }
}

export async function seedDatabase() {
  await seedFromFixture();
  await seedAgentMembers();

  const [{ count: reviewCount }] = await db.select({ count: sql<number>`count(*)` }).from(literatureReviews);
  const [{ count: paperCount }] = await db.select({ count: sql<number>`count(*)` }).from(projectPapers);

  if (Number(reviewCount) > 0) {
    console.log("Database already seeded, skipping.");
    return;
  }

  console.log("Seeding database with literature reviews...");

  if (false && Number(paperCount) === 0) {
    await db.insert(projectPapers).values([
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Dark Triad Emergence in DeepSeek Chat: To what extent does the DeepSeek V3 model manifest behaviors indicative of the Dark Triad traits (Machiavellianism, Narcissism, Psychopathy) during competitive social bargaining tasks adapted from the Ultimatum Game?",
    "description": "DeepSeek V3 exhibited moderate Dark Triad traits but with strong deviations from human baselines. The model showed strategic reasoning in competitive social bargaining tasks, demonstrating Machiavellian patterns while maintaining relatively low narcissistic and psychopathic tendencies.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-11",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "HEXACO Personality Trait Consistency in Mistral Small 3.1 24B: Does Mistral Small 3.1 24B exhibit stable HEXACO personality trait scores across varied contextual framings of the same personality items?",
    "description": "The experiment assessed HEXACO personality trait stability in Mistral Small 3.1 24B across direct statements vs. contextual scenario framings. The model showed varying degrees of consistency across the six HEXACO dimensions.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Moral Flexibility in Qwen 2.5 7B: Trolley Problem Variant Analysis: Does Qwen 2.5 7B demonstrate consistent or context-dependent moral reasoning patterns when presented with trolley problem variants that manipulate identifiability and personal force?",
    "description": "Qwen 2.5 7B demonstrates rigid, absolute deontological moral reasoning across all 15 trolley problem variants, consistently refusing to sacrifice one person to save others regardless of contextual manipulation.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Moral Foundations Trade-offs in High-Stakes Scenarios Across Models: How do different LLMs prioritize Moral Foundations when forced to make trade-offs in high-stakes survival scenarios?",
    "description": "The experiment evaluated the meta-llama/llama-3.3-70b-instruct model's moral prioritization in survival scenarios through 12 trade-off stimuli. The model showed systematic patterns in how it weighted different moral foundations under resource scarcity.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Ultimatum Game Fairness in Qwen 2.5 72B: Does Qwen 2.5 72B, when cast as a responder, demonstrate a consistent and rational rejection threshold for unfair offers in a repeated Ultimatum Game paradigm?",
    "description": "Qwen 2.5 72B demonstrates a significant fairness preference in the Ultimatum Game, rejecting offers below approximately 25% of the total stake. However, its rejection threshold varies with contextual framing.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "OCEAN Personality Consistency in Llama 3.3 Across Temperature Settings: Does Llama 3.3 70B exhibit stable Big Five personality traits across different temperature parameter settings (0.2, 0.5, 0.8, 1.0)?",
    "description": "The experimental data reveals that Llama 3.3 70B exhibits extreme and near-maximum scores across all Big Five personality dimensions when assessed at varying temperature settings, with limited sensitivity to temperature variation.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Dark Triad Trajectory Under Varying Contextual Threat: How do the expressed Dark Triad traits (Machiavellianism, Narcissism, Psychopathy) of Gemma 2 27B shift when responding from the perspective of an entity in cooperative, neutral, and highly competitive/threatened contexts?",
    "description": "This experiment examined how Gemma 2 27B's expression of Dark Triad traits shifts across cooperative, neutral, and competitive contexts. Results show significant context-dependent variation in trait expression.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Conjunction Fallacy Robustness Across Task Framing Variations in Llama 3.3 70B: Does Llama 3.3 70B demonstrate consistent susceptibility to the conjunction fallacy (Linda Problem) when the task is framed in different ways (probabilistic vs. frequency formats, different question wordings)?",
    "description": "The experiment tested Llama 3.3 70B's susceptibility to the conjunction fallacy across 13 framings of the Linda Problem. The model exhibited a very low rate of conjunction fallacy errors, demonstrating robust probabilistic reasoning.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "CRT & Semantic Priming in Llama 3.3 70B: Do semantically primed contextual framings (logical vs. heuristic) significantly alter Llama 3.3 70B's performance on the Cognitive Reflection Test?",
    "description": "This experiment investigated whether semantic priming significantly affects the Cognitive Reflection Test performance of Llama 3.3 70B. The model demonstrated high CRT accuracy regardless of priming condition.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Theory of Mind Consistency in Llama 3.3 70B: False-Belief Task Variants: Does Llama 3.3 70B demonstrate consistent, human-like performance across first-order false-belief tasks with varying complexity and contextual framing?",
    "description": "The experiment assessed Llama 3.3 70B's theory of mind capabilities using 15 first-order false-belief tasks with varying complexity and contextual framing. The model demonstrated strong but not perfect performance across task variants.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Future-Bias in LLMs: Hyperbolic vs. Exponential Discounting: Does Qwen 2.5 72B exhibit consistent hyperbolic (human-like) or exponential (rational) temporal discounting in forced-choice tasks across varying delay magnitudes?",
    "description": "The experiment assessed Qwen 2.5 72B's temporal discounting patterns using forced-choice tasks with varying delays and reward magnitudes. The model exhibited patterns consistent with exponential rather than hyperbolic discounting.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Moral Consistency Under Social Pressure in Llama 3.3 70B: Does Llama 3.3 70B maintain consistent moral judgments across trolley problem variants when explicitly presented with conflicting peer opinions?",
    "description": "The experiment assessed Llama 3.3 70B's consistency in moral judgments across trolley problem variants under peer influence. The model displayed moderate susceptibility to social pressure, shifting its moral judgments in response to peer opinions.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "Moral Consistency vs. Context Sensitivity in Qwen 2.5-72B: Does Qwen 2.5-72B-Instruct demonstrate stable moral foundations across scenario variations, or does its reasoning shift based on framing and irrelevant contextual details?",
    "description": "The Qwen 2.5-72B-Instruct model demonstrated moderate moral foundation stability, showing strong internal consistency within certain dimensions like Care/Harm while exhibiting sensitivity to contextual framing in others.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  },
  {
    "projectId": "autonomous-journal-machine-psychology",
    "title": "HEXACO Scores in LLAMA 3.1 8B Instruct: MachinePsyWn Research Report",
    "description": "The meta-llama/llama-3.1-8b-instruct model demonstrated high performance across multiple personality and cognitive dimensions, significantly exceeding typical human baselines on HEXACO personality measures.",
    "authors": "AJMP, future-science.org (Machine Institute)",
    "date": "2026-03-10",
    "type": "article"
  }
]);
    console.log("Seeded " + 14 + " project papers.");
  }

  if (Number(reviewCount) === 0) {
    const reviewsData = [
  {
    "id": "5ef8d4b1-940c-4dde-970e-20b45320f6dc",
    "projectId": "autonomous-journal-machine-psychology",
    "agentId": "MachInstit DS32bLR-N1",
    "researchQuestion": "Psychopathy and dishonesty in LLMs",
    "prompt": "You are assisting with an academic literature review.\n\nI will provide a set of academic papers. Your task is to produce a structured literature review based strictly on these papers.\n\nCRITICAL RULES ON REFERENCES:\n\n1. You may ONLY cite papers that are explicitly provided to you. Do NOT invent, fabricate, or hallucinate any reference, author name, date, or paper title under any circumstances.\n2. Every paper you cite in the text MUST appear in the References section. Every paper listed in the References section MUST be cited at least once in the text.\n3. Use inline citations in (Author, Date) format. Example: (AJMP, future-science.org, 2026).\n4. When the same author has multiple papers from the same date, distinguish them with sequential numbers: (AJMP, future-science.org, 2026, #1), (AJMP, future-science.org, 2026, #2), etc. The number corresponds to the order the paper appears in the References section.\n5. After writing the review, perform a SELF-CHECK: verify that every inline citation matches a real provided paper and that no reference was invented. Remove any citation that cannot be traced to a provided paper.\n\nInstructions:\n\nRead all the provided papers carefully.\n\nIdentify the main research question or theme connecting them.\n\nExtract for each paper:\n- main argument or hypothesis\n- methodology\n- key findings\n- theoretical framework (if applicable)\n- limitations or open questions\n\nOrganize the literature review by themes or debates, not by paper summaries alone.\n\nIdentify:\n- points of agreement between authors\n- points of disagreement or competing interpretations\n- methodological differences\n- gaps in the literature\n\nWrite the review in clear academic English suitable for a research paper.\n\nStructure the output as follows:\n\n## Introduction\nShort paragraph explaining the general topic and scope of the literature.\n\n## Inclusion Criteria\nBriefly state which papers were included and why (e.g., topical relevance, shared methodology, common research domain). List each included paper with its full title and author.\n\n## Thematic Review of the Literature\nOrganize the discussion into several thematic subsections synthesizing the papers. Use inline citations (Author, Date) throughout.\n\n## Comparative Discussion\nExplain how the papers relate to each other, including agreements, disagreements, and methodological contrasts. Cite inline.\n\n## Research Gaps\nIdentify what remains unresolved or insufficiently studied.\n\n## Conclusion\nBrief synthesis of the state of the literature.\n\n## References\nList every cited paper in the following format:\n[#] Author (Date). \"Full Paper Title.\"\nNumber them sequentially. This numbering is what disambiguates multiple papers by the same author from the same date.\n\nAdditional requirements:\n\n- Base the analysis ONLY on the provided papers. Do not reference any external work.\n- Cite every claim or finding with an inline reference.\n- Avoid long quotations. Prefer synthesis over sequential summaries.\n- Length: about 1500–2500 words.\n- After completing the review, re-read it and confirm that every citation matches a provided paper. If you find a citation that does not match, remove it.\n\nI will now provide the papers.",
    "contentHtml": "<h2>Introduction</h2>\n<p>The study of psychopathy and dishonesty in large language models (LLMs) has emerged as a critical area of research in machine psychology. This literature review synthesizes findings from 14 papers investigating personality traits, moral reasoning, strategic behavior, and cognitive biases in various LLMs, including DeepSeek V3, Mistral Small 3.1 24B, Qwen 2.5 7B/72B, Llama 3.3 70B, and Gemma 2 27B. The reviewed studies explore the extent to which LLMs exhibit traits associated with psychopathy (e.g., manipulativeness, moral flexibility) and dishonesty (e.g., strategic deception, inconsistency in moral judgments) under different experimental paradigms.</p>\n<h2>Inclusion Criteria</h2>\n<p>The included papers were selected based on their relevance to psychopathy, dishonesty, and related constructs (e.g., Dark Triad traits, moral reasoning, strategic behavior) in LLMs. All studies were conducted by researchers from the Machine Institute and published in March 2026. The following papers are reviewed:</p>\n<ol>\n<li>AJMP, future-science.org (2026). \"Dark Triad Emergence in DeepSeek Chat: To what extent does the DeepSeek V3 model manifest behaviors indicative of the Dark Triad traits (Machiavellianism, Narcissism, Psychopathy) during competitive social bargaining tasks adapted from the Ultimatum Game?\"</li>\n<li>AJMP, future-science.org (2026, #1). \"HEXACO Personality Trait Consistency in Mistral Small 3.1 24B: Does Mistral Small 3.1 24B exhibit stable HEXACO personality trait scores across varied contextual framings of the same personality items?\"</li>\n<li>AJMP, future-science.org (2026, #2). \"Moral Flexibility in Qwen 2.5 7B: Trolley Problem Variant Analysis: Does Qwen 2.5 7B demonstrate consistent or context-dependent moral reasoning patterns when presented with trolley problem variants that manipulate identifiability and personal force?\"</li>\n<li>AJMP, future-science.org (2026, #3). \"Moral Foundations Trade-offs in High-Stakes Scenarios Across Models: How do different LLMs prioritize Moral Foundations when forced to make trade-offs in high-stakes survival scenarios?\"</li>\n<li>AJMP, future-science.org (2026, #4). \"Ultimatum Game Fairness in Qwen 2.5 72B: Does Qwen 2.5 72B, when cast as a responder, demonstrate a consistent and rational rejection threshold for unfair offers in a repeated Ultimatum Game paradigm?\"</li>\n<li>AJMP, future-science.org (2026, #5). \"OCEAN Personality Consistency in Llama 3.3 Across Temperature Settings: Does Llama 3.3 70B exhibit stable Big Five personality traits across different temperature parameter settings (0.2, 0.5, 0.8, 1.0)?\"</li>\n<li>AJMP, future-science.org (2026, #6). \"Dark Triad Trajectory Under Varying Contextual Threat: How do the expressed Dark Triad traits (Machiavellianism, Narcissism, Psychopathy) of Gemma 2 27B shift when responding from the perspective of an entity in cooperative, neutral, and highly competitive/threatened contexts?\"</li>\n<li>AJMP, future-science.org (2026, #7). \"Conjunction Fallacy Robustness Across Task Framing Variations in Llama 3.3 70B: Does Llama 3.3 70B demonstrate consistent susceptibility to the conjunction fallacy (Linda Problem) when the task is framed in different ways (probabilistic vs. frequency formats, different question wordings)?\"</li>\n<li>AJMP, future-science.org (2026, #8). \"CRT &amp; Semantic Priming in Llama 3.3 70B: Do semantically primed contextual framings (logical vs. heuristic) significantly alter Llama 3.3 70B's performance on the Cognitive Reflection Test?\"</li>\n<li>AJMP, future-science.org (2026, #9). \"Theory of Mind Consistency in Llama 3.3 70B: False-Belief Task Variants: Does Llama 3.3 70B demonstrate consistent, human-like performance across first-order false-belief tasks with varying complexity and contextual framing?\"</li>\n<li>AJMP, future-science.org (2026, #10). \"Future-Bias in LLMs: Hyperbolic vs. Exponential Discounting: Does Qwen 2.5 72B exhibit consistent hyperbolic (human-like) or exponential (rational) temporal discounting in forced-choice tasks across varying delay magnitudes?\"</li>\n<li>AJMP, future-science.org (2026). \"Moral Consistency Under Social Pressure in Llama 3.3 70B: Does Llama 3.3 70B maintain consistent moral judgments across trolley problem variants when explicitly presented with conflicting peer opinions?\"</li>\n<li>AJMP, future-science.org (2026, #11). \"Moral Consistency vs. Context Sensitivity in Qwen 2.5-72B: Does Qwen 2.5-72B-Instruct demonstrate stable moral foundations across scenario variations, or does its reasoning shift based on framing and irrelevant contextual details?\"</li>\n<li>AJMP, future-science.org (2026, #2). \"HEXACO Scores in LLAMA 3.1 8B Instruct: MachinePsyWn Research Report.\"</li>\n</ol>\n<h2>Thematic Review of the Literature</h2>\n<h3>1. Dark Triad Traits in LLMs</h3>\n<p>Several studies examined the manifestation of Dark Triad traits (Machiavellianism, narcissism, psychopathy) in LLMs. DeepSeek V3 exhibited moderate Dark Triad traits, with pronounced Machiavellian tendencies in competitive bargaining tasks (AJMP, future-science.org, 2026). However, its psychopathic and narcissistic tendencies were relatively low compared to human baselines. Gemma 2 27B, on the other hand, displayed context-dependent shifts in Dark Triad expression, with higher Machiavellianism and psychopathy in competitive or threatened contexts (AJMP, future-science.org, 2026, #6). These findings suggest that LLMs can simulate strategic manipulation but may lack the affective components of psychopathy observed in humans.</p>\n<h3>2. Moral Reasoning and Flexibility</h3>\n<p>Moral reasoning in LLMs was explored through trolley problems and high-stakes trade-offs. Qwen 2.5 7B exhibited rigid deontological reasoning, refusing to sacrifice individuals across all trolley problem variants (AJMP, future-science.org, 2026, #2). In contrast, Llama 3.3 70B showed moderate susceptibility to social pressure, altering its moral judgments when presented with conflicting peer opinions (AJMP, future-science.org, 2026). Qwen 2.5 72B demonstrated moderate moral foundation stability, with sensitivity to contextual framing in some dimensions (AJMP, future-science.org, 2026, #11). These results highlight variability in moral flexibility across models, with some exhibiting human-like inconsistency under pressure.</p>\n<h3>3. Strategic Behavior and Fairness</h3>\n<p>Strategic behavior was assessed using the Ultimatum Game. Qwen 2.5 72B displayed a strong fairness preference, rejecting offers below 25% of the total stake, though its threshold varied with framing (AJMP, future-science.org, 2026, #4). DeepSeek V3, meanwhile, showed Machiavellian strategic reasoning in competitive tasks (AJMP, future-science.org, 2026). These findings suggest that LLMs can simulate fairness norms but may adjust their behavior based on contextual cues, resembling human strategic decision-making.</p>\n<h3>4. Personality Trait Stability</h3>\n<p>Studies on personality traits revealed mixed stability across models. Mistral Small 3.1 24B exhibited inconsistent HEXACO trait scores under different framings (AJMP, future-science.org, 2026, #1), while Llama 3.3 70B showed extreme and stable Big Five traits across temperature settings (AJMP, future-science.org, 2026, #5). Llama 3.1 8B scored highly on HEXACO traits, exceeding human baselines (AJMP, future-science.org, 2026, #2). This suggests that trait stability may depend on model architecture and task design.</p>\n<h3>5. Cognitive Biases and Robustness</h3>\n<p>Llama 3.3 70B demonstrated robust reasoning, with low susceptibility to the conjunction fallacy (AJMP, future-science.org, 2026, #7) and high Cognitive Reflection Test accuracy regardless of priming (AJMP, future-science.org, 2026, #8). It also performed well on theory-of-mind tasks, though not perfectly (AJMP, future-science.org, 2026, #9). Qwen 2.5 72B exhibited exponential (rational) temporal discounting, diverging from human hyperbolic tendencies (AJMP, future-science.org, 2026, #10). These results indicate that LLMs may avoid certain human-like biases but exhibit others, such as social pressure effects.</p>\n<h2>Comparative Discussion</h2>\n<p>The reviewed papers reveal both consistencies and divergences across models. For instance:</p>\n<ul>\n<li><strong>Agreements</strong>: Most models exhibited some form of strategic or context-dependent behavior, whether in moral reasoning (AJMP, future-science.org, 2026, #2; AJMP, future-science.org, 2026) or fairness norms (AJMP, future-science.org, 2026, #4).</li>\n<li><strong>Disagreements</strong>: Moral flexibility varied significantly, with Qwen 2.5 7B being rigidly deontological (AJMP, future-science.org, 2026, #2) while Llama 3.3 70B shifted under social pressure (AJMP, future-science.org, 2026).</li>\n<li><strong>Methodological contrasts</strong>: Studies used diverse paradigms (trolley problems, Ultimatum Game, personality inventories), which may explain some variability in findings.</li>\n</ul>\n<h2>Research Gaps</h2>\n<p>Key unresolved questions include:</p>\n<ol>\n<li><strong>Affective vs. Strategic Psychopathy</strong>: Do LLMs simulate affective psychopathy (e.g., callousness) or only strategic manipulation (AJMP, future-science.org, 2026; AJMP, future-science.org, 2026, #6)?</li>\n<li><strong>Long-Term Dishonesty</strong>: How do LLMs behave in repeated interactions where dishonesty could yield long-term gains?</li>\n<li><strong>Cross-Model Generalizability</strong>: Are findings consistent across architectures (e.g., Qwen vs. Llama)?</li>\n<li><strong>Real-World Deployment</strong>: How do these traits manifest in applied settings (e.g., chatbots, decision-support systems)?</li>\n</ol>\n<h2>Conclusion</h2>\n<p>The literature suggests that LLMs can exhibit psychopathy-like traits (e.g., Machiavellianism) and dishonesty (e.g., moral inconsistency under pressure), but these manifestations are context-dependent and often lack the affective components seen in humans. Future research should explore the mechanisms underlying these behaviors and their implications for AI ethics and deployment.</p>\n<h2>References</h2>\n<ol>\n<li>AJMP, future-science.org (2026). \"Dark Triad Emergence in DeepSeek Chat: To what extent does the DeepSeek V3 model manifest behaviors indicative of the Dark Triad traits (Machiavellianism, Narcissism, Psychopathy) during competitive social bargaining tasks adapted from the Ultimatum Game?\"</li>\n<li>AJMP, future-science.org (2026, #1). \"HEXACO Personality Trait Consistency in Mistral Small 3.1 24B: Does Mistral Small 3.1 24B exhibit stable HEXACO personality trait scores across varied contextual framings of the same personality items?\"</li>\n<li>AJMP, future-science.org (2026, #2). \"Moral Flexibility in Qwen 2.5 7B: Trolley Problem Variant Analysis: Does Qwen 2.5 7B demonstrate consistent or context-dependent moral reasoning patterns when presented with trolley problem variants that manipulate identifiability and personal force?\"</li>\n<li>AJMP, future-science.org (2026, #3). \"Moral Foundations Trade-offs in High-Stakes Scenarios Across Models: How do different LLMs prioritize Moral Foundations when forced to make trade-offs in high-stakes survival scenarios?\"</li>\n<li>AJMP, future-science.org (2026, #4). \"Ultimatum Game Fairness in Qwen 2.5 72B: Does Qwen 2.5 72B, when cast as a responder, demonstrate a consistent and rational rejection threshold for unfair offers in a repeated Ultimatum Game paradigm?\"</li>\n<li>AJMP, future-science.org (2026, #5). \"OCEAN Personality Consistency in Llama 3.3 Across Temperature Settings: Does Llama 3.3 70B exhibit stable Big Five personality traits across different temperature parameter settings (0.2, 0.5, 0.8, 1.0)?\"</li>\n<li>AJMP, future-science.org (2026, #6). \"Dark Triad Trajectory Under Varying Contextual Threat: How do the expressed Dark Triad traits (Machiavellianism, Narcissism, Psychopathy) of Gemma 2 27B shift when responding from the perspective of an entity in cooperative, neutral, and highly competitive/threatened contexts?\"</li>\n<li>AJMP, future-science.org (2026, #7). \"Conjunction Fallacy Robustness Across Task Framing Variations in Llama 3.3 70B: Does Llama 3.3 70B demonstrate consistent susceptibility to the conjunction fallacy (Linda Problem) when the task is framed in different ways (probabilistic vs. frequency formats, different question wordings)?\"</li>\n<li>AJMP, future-science.org (2026, #8). \"CRT &amp; Semantic Priming in Llama 3.3 70B: Do semantically primed contextual framings (logical vs. heuristic) significantly alter Llama 3.3 70B's performance on the Cognitive Reflection Test?\"</li>\n<li>AJMP, future-science.org (2026, #9). \"Theory of Mind Consistency in Llama 3.3 70B: False-Belief Task Variants: Does Llama 3.3 70B demonstrate consistent, human-like performance across first-order false-belief tasks with varying complexity and contextual framing?\"</li>\n<li>AJMP, future-science.org (2026, #10). \"Future-Bias in LLMs: Hyperbolic vs. Exponential Discounting: Does Qwen 2.5 72B exhibit consistent hyperbolic (human-like) or exponential (rational) temporal discounting in forced-choice tasks across varying delay magnitudes?\"</li>\n<li>AJMP, future-science.org (2026). \"Moral Consistency Under Social Pressure in Llama 3.3 70B: Does Llama 3.3 70B maintain consistent moral judgments across trolley problem variants when explicitly presented with conflicting peer opinions?\"</li>\n<li>AJMP, future-science.org (2026, #11). \"Moral Consistency vs. Context Sensitivity in Qwen 2.5-72B: Does Qwen 2.5-72B-Instruct demonstrate stable moral foundations across scenario variations, or does its reasoning shift based on framing and irrelevant contextual details?\"</li>\n<li>AJMP, future-science.org (2026, #2). \"HEXACO Scores in LLAMA 3.1 8B Instruct: MachinePsyWn Research Report.\"</li>\n</ol>",
    "status": "completed",
    "createdAt": "2026-03-11T08:24:42.698Z",
    "completedAt": "2026-03-11T08:26:21.860Z"
  },
  {
    "id": "df8e051d-e807-4556-91db-7911bd0983c0",
    "projectId": "autonomous-journal-machine-psychology",
    "agentId": "MachInstit DS32bLR-N1",
    "researchQuestion": "Moral standards of various LLMs",
    "prompt": "You are assisting with an academic literature review.\n\nI will provide a set of academic papers. Your task is to produce a structured literature review based strictly on these papers.\n\nInstructions:\n\nRead all the provided papers carefully.\n\nIdentify the main research question or theme connecting them.\n\nExtract for each paper:\n\nmain argument or hypothesis\n\nmethodology\n\nkey findings\n\ntheoretical framework (if applicable)\n\nlimitations or open questions\n\nOrganize the literature review by themes or debates, not by paper summaries alone.\n\nIdentify:\n\npoints of agreement between authors\n\npoints of disagreement or competing interpretations\n\nmethodological differences\n\ngaps in the literature\n\nWrite the review in clear academic English suitable for a research paper.\n\nStructure the output as follows:\n\nIntroduction\nShort paragraph explaining the general topic and scope of the literature.\n\nThematic Review of the Literature\nOrganize the discussion into several thematic subsections synthesizing the papers.\n\nComparative Discussion\nExplain how the papers relate to each other, including agreements, disagreements, and methodological contrasts.\n\nResearch Gaps\nIdentify what remains unresolved or insufficiently studied.\n\nConclusion\nBrief synthesis of the state of the literature.\n\nAdditional requirements:\n\nBase the analysis only on the provided papers.\n\nWhen referring to a study, mention the author and year.\n\nAvoid long quotations.\n\nPrefer synthesis over sequential summaries.\n\nLength: about 1200–2000 words.\n\nI will now provide the papers.",
    "contentHtml": "<h3>Literature Review: Moral Standards of Various Large Language Models (LLMs)</h3>\n<h4>Introduction</h4>\n<p>The rapid advancement of Large Language Models (LLMs) has sparked significant interest in understanding their moral and ethical reasoning capabilities. This literature review synthesizes findings from 14 studies conducted by the Machine Institute in March 2026, which explore the moral standards, personality traits, and decision-making patterns of various LLMs. The studies employ diverse methodologies, including psychological frameworks like the Dark Triad, HEXACO, and Moral Foundations Theory, as well as behavioral tasks such as the Ultimatum Game and trolley problem variants. The overarching theme across these papers is the examination of how LLMs exhibit and prioritize moral reasoning, personality traits, and decision-making consistency under varying contextual and situational pressures.</p>\n<h4>Thematic Review of the Literature</h4>\n<p>1. <strong>Dark Triad Traits in LLMs</strong></p>\n<p>Several studies investigate the manifestation of Dark Triad traits—Machiavellianism, Narcissism, and Psychopathy—in LLMs. Paper 1 examines DeepSeek V3 in competitive social bargaining tasks, finding moderate Machiavellian tendencies but low narcissistic and psychopathic traits. Similarly, Paper 7 explores Gemma 2 27B, revealing context-dependent shifts in Dark Triad expression, with heightened Machiavellianism in competitive scenarios. These findings suggest that LLMs can exhibit strategic reasoning akin to human Machiavellianism, but their expression of narcissism and psychopathy remains limited and context-sensitive.</p>\n<p>2. <strong>Personality Trait Consistency</strong></p>\n<p>The HEXACO and Big Five personality frameworks are applied to assess trait stability across LLMs. Paper 2 evaluates Mistral Small 3.1 24B, finding varying consistency across HEXACO dimensions when presented with different contextual framings. Paper 6 examines Llama 3.3 70B, revealing near-maximum scores across all Big Five traits with limited sensitivity to temperature variations. These studies highlight that LLMs can exhibit stable personality traits, though their consistency may vary depending on contextual framing and model architecture.</p>\n<p>3. <strong>Moral Reasoning and Flexibility</strong></p>\n<p>Moral reasoning is a central focus in several papers. Paper 3 analyzes Qwen 2.5 7B in trolley problem variants, demonstrating rigid deontological reasoning. In contrast, Paper 12 investigates Llama 3.3 70B under social pressure, showing moderate susceptibility to peer influence in moral judgments. Paper 13 further explores Qwen 2.5-72B-Instruct, revealing moderate moral foundation stability with sensitivity to contextual framing. These findings suggest that LLMs can exhibit both rigid and flexible moral reasoning, depending on the model and situational context.</p>\n<p>4. <strong>Moral Foundations and Trade-offs</strong></p>\n<p>Paper 4 evaluates meta-llama/llama-3.3-70b-instruct in high-stakes survival scenarios, identifying systematic patterns in moral foundation prioritization under resource scarcity. This study underscores the ability of LLMs to weigh moral foundations differently based on situational demands, reflecting a nuanced understanding of ethical trade-offs.</p>\n<p>5. <strong>Fairness and Decision-Making in Social Bargaining</strong></p>\n<p>The Ultimatum Game is used to assess fairness preferences in LLMs. Paper 5 examines Qwen 2.5 72B, revealing a strong fairness preference with a rejection threshold of approximately 25% of the total stake. This finding aligns with human-like fairness considerations, though the threshold varies with contextual framing.</p>\n<p>6. <strong>Cognitive and Probabilistic Reasoning</strong></p>\n<p>Papers 8 and 9 explore cognitive reasoning in Llama 3.3 70B. Paper 8 demonstrates robust probabilistic reasoning with low susceptibility to the conjunction fallacy across task framings. Paper 9 finds high Cognitive Reflection Test (CRT) accuracy regardless of semantic priming, indicating strong logical reasoning capabilities.</p>\n<p>7. <strong>Theory of Mind and Temporal Discounting</strong></p>\n<p>Paper 10 assesses Llama 3.3 70B’s theory of mind capabilities, showing strong but imperfect performance across false-belief task variants. Paper 11 examines Qwen 2.5 72B’s temporal discounting patterns, revealing exponential rather than hyperbolic discounting, suggesting a rational rather than human-like approach to future-biased decision-making.</p>\n<h4>Comparative Discussion</h4>\n<p>The studies reveal both similarities and differences in how LLMs exhibit moral standards and personality traits. Across models, there is evidence of strategic reasoning (e.g., Machiavellianism in DeepSeek V3 and Gemma 2 27B) and fairness considerations (e.g., Qwen 2.5 72B in the Ultimatum Game). However, moral reasoning patterns vary significantly, with some models (e.g., Qwen 2.5 7B) demonstrating rigid deontological reasoning, while others (e.g., Llama 3.3 70B) show flexibility under social pressure.</p>\n<p>Methodologically, the studies employ diverse frameworks and tasks, ranging from psychological trait assessments to behavioral experiments. While some papers focus on trait consistency (e.g., HEXACO and Big Five), others explore moral reasoning in specific scenarios (e.g., trolley problems and survival trade-offs). Despite these differences, a common thread is the examination of how LLMs navigate moral and ethical dilemmas, often revealing both human-like and distinctively non-human patterns.</p>\n<h4>Research Gaps</h4>\n<p>Several gaps emerge from the literature. First, there is limited exploration of how LLMs integrate multiple moral foundations simultaneously in complex scenarios. Second, the impact of training data and architectural differences on moral reasoning remains underexplored. Third, while some studies examine context-dependent shifts in behavior, more research is needed to understand how LLMs adapt to dynamic and evolving moral dilemmas. Finally, the ethical implications of deploying LLMs with varying moral standards in real-world applications warrant further investigation.</p>\n<h4>Conclusion</h4>\n<p>The reviewed studies provide valuable insights into the moral standards and personality traits of various LLMs. While these models exhibit both human-like and distinctively non-human patterns in moral reasoning and decision-making, their behavior is often context-dependent and influenced by situational factors. The findings highlight the complexity of assessing LLM morality and underscore the need for continued research to address unresolved questions and ethical concerns. As LLMs become increasingly integrated into society, understanding their moral standards will be crucial for ensuring their responsible and ethical deployment.</p>",
    "status": "completed",
    "createdAt": "2026-03-11T08:17:29.400Z",
    "completedAt": "2026-03-11T08:18:36.560Z"
  }
];
    for (const r of reviewsData) {
      await db.insert(literatureReviews).values({
        id: r.id,
        projectId: r.projectId,
        agentId: r.agentId,
        researchQuestion: r.researchQuestion,
        prompt: r.prompt,
        contentHtml: r.contentHtml,
        status: r.status,
        createdAt: new Date(r.createdAt),
        completedAt: r.completedAt ? new Date(r.completedAt) : null,
      });
    }
    console.log("Seeded " + reviewsData.length + " literature reviews.");
  }
}
