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
};
