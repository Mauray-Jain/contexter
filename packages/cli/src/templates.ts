// Starter structures for `contexter init --template`. A template seeds the manifest and
// the first units; everything else about a workspace is generic.

export interface UnitSeed {
  collection: string;
  key: string;
  status?: string;
  position?: number;
}

export interface Template {
  description: string;
  manifest: Record<string, unknown>;
  units: UnitSeed[];
}

const paperSections = [
  "abstract", "introduction", "related-work", "method",
  "experiments", "results", "discussion", "conclusion",
];

export const templates: Record<string, Template> = {
  blank: {
    description: "No structure; define collections as you go",
    manifest: { collections: {}, rules: [] },
    units: [],
  },
  "research-paper": {
    description: "Ordered paper sections, notes and references",
    manifest: {
      collections: {
        sections: { kind: "managed", ordered: true, statuses: ["outline", "drafting", "review", "final"] },
        notes: { kind: "managed", ordered: false, statuses: ["open", "done"] },
        refs: { kind: "managed", ordered: false, statuses: ["active"] },
      },
      rules: [
        "Use pandoc citations [@key]; every key must exist in refs/bibliography",
        "Write in present tense, first person plural",
      ],
      export: { pipeline: "pandoc", include_records: "optional" },
    },
    units: [
      ...paperSections.map((key, i) => ({ collection: "sections", key, status: "outline", position: i + 1 })),
      { collection: "refs", key: "bibliography", status: "active" },
    ],
  },
  software: {
    description: "Specs and design docs; code lives in your git repo and is linked by path",
    manifest: {
      collections: {
        specs: { kind: "managed", ordered: false, statuses: ["draft", "review", "accepted", "superseded"] },
        modules: { kind: "linked", ordered: false, statuses: ["planned", "building", "done"] },
        notes: { kind: "managed", ordered: false, statuses: ["open", "done"] },
      },
      rules: [
        "Code changes go through the project's git repo; record why in contexter (decision / rationale)",
        "Every accepted spec links the decisions it depends on",
      ],
      export: { pipeline: "pandoc", collection: "specs", include_records: "optional" },
    },
    units: [
      { collection: "specs", key: "overview", status: "draft", position: 1 },
      { collection: "specs", key: "architecture", status: "draft", position: 2 },
    ],
  },
  book: {
    description: "Ordered chapters plus characters and world notes",
    manifest: {
      collections: {
        chapters: { kind: "managed", ordered: true, statuses: ["outline", "drafting", "editing", "final"] },
        characters: { kind: "managed", ordered: false, statuses: ["sketch", "settled"] },
        world: { kind: "managed", ordered: false, statuses: ["sketch", "settled"] },
      },
      rules: [
        "Check characters/ and world/ before writing; record any change to canon as a decision",
        "Keep tense and point of view consistent with chapter 1",
      ],
      export: { pipeline: "pandoc", collection: "chapters", include_records: "never" },
    },
    units: [
      { collection: "chapters", key: "chapter-01", status: "outline", position: 1 },
      { collection: "world", key: "setting", status: "sketch" },
    ],
  },
  spec: {
    description: "Requirements and designs, each requirement traced to decisions",
    manifest: {
      collections: {
        requirements: { kind: "managed", ordered: true, statuses: ["proposed", "accepted", "rejected"] },
        designs: { kind: "managed", ordered: false, statuses: ["draft", "review", "accepted"] },
      },
      rules: [
        "Number requirements as R1, R2…; never renumber",
        "Every accepted requirement links at least one decision record",
      ],
      export: { pipeline: "pandoc", collection: "requirements", include_records: "optional" },
    },
    units: [
      { collection: "requirements", key: "goals", status: "proposed", position: 1 },
      { collection: "designs", key: "approach", status: "draft" },
    ],
  },
  "knowledge-base": {
    description: "Unordered topics that grow over time",
    manifest: {
      collections: { topics: { kind: "managed", ordered: false, statuses: ["stub", "useful", "complete"] } },
      rules: ["One topic per unit; link related topics in the text as topics/<key>"],
      export: { pipeline: "pandoc", collection: "topics", include_records: "never" },
    },
    units: [{ collection: "topics", key: "index", status: "stub" }],
  },
};
