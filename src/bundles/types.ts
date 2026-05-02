export type BundleFrontmatter = {
  title: string;
  framework: string;
  prerequisites: string[];
  last_verified: string;
};

export type Bundle = {
  name: string;
  title: string;
  framework: string;
  prerequisites: string[];
  last_verified: string;
  content: string;
};
