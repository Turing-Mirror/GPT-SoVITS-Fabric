import { invoke } from "@tauri-apps/api/core";
import { versions as engineVersions } from "../../src-tauri/engine-payload/configs/upstream_versions.json";
import { t } from "../i18n/t";

export type License = { id?: string; url?: string; text?: string };
export type SourceFile = {
  id: string;
  path: string;
  sizeBytes: number;
  assetId?: string;
  blobId?: string;
  updatedAt?: string;
  providerDigest?: { algorithm: string; value: string };
};
export type Source = {
  resolveId: string;
  expiresAt: string;
  canonicalUrl: string;
  revision: string;
  detectedLicense?: { license: License };
  files: SourceFile[];
};
export type PublisherRole = "original_author" | "reposter" | "maintainer";
export type ReviewState = "pending" | "published" | "rejected" | "withdrawn";
export type Submission = {
  id: string;
  batchId?: string;
  operation?: "create" | "new_version";
  assetId?: string;
  state: ReviewState;
  asset: {
    title: string;
    description: string;
    originalAuthor: string;
    authorUrl?: string;
    publisherRole: PublisherRole;
    license: License;
    metadata?: { familyVersion?: string; series?: string; group?: string };
  };
  version: {
    label: string;
    metadata?: { familyVersion?: string };
    files: Array<{ path: string; sha256: string; sources: Array<{ canonicalUrl: string; revision: string }> }>;
  };
  updatedAt: string;
  reviews: Array<{ reason: string }>;
};

type Selection = Omit<Source, "files" | "detectedLicense"> & { file: SourceFile; account: string };
type SubmissionBody = {
  operation: "create" | "new_version";
  assetId?: string;
  previousSubmissionId?: string;
  asset: Submission["asset"] & { kind: "model"; upstreamUrl: string; metadata: { family: string; familyVersion: string; format: string; series?: string; group?: string; language?: string } };
  version: { label: string; files: Array<{ path: string; role: "package"; resolveId: string; sourceFileId: string; sha256?: string }>; dependencies: [] };
  coverUploadId?: string;
};
export type Draft = {
  id: string;
  url: string;
  revision: string;
  title: string;
  description: string;
  originalAuthor: string;
  authorUrl: string;
  publisherRole: PublisherRole;
  license: License;
  licenseEdited?: boolean;
  baseVersion?: string;
  label: string;
  series: string;
  group: string;
  cover: string;
  coverPath?: string;
  checksum: string;
  updatedAt?: string;
  selection?: Selection;
  previousSubmissionId?: string;
  assetId?: string;
  language?: string;
  pending?: { account: string; key: string; body: SubmissionBody };
};

export function newDraft(previous?: Submission, assetId?: string): Draft {
  const file = previous?.version.files[0];
  const source = file?.sources[0];
  return {
    id: crypto.randomUUID(),
    url: source?.canonicalUrl ?? "",
    revision: source?.revision ?? "",
    title: previous?.asset.title ?? "",
    description: previous?.asset.description ?? "",
    originalAuthor: previous?.asset.originalAuthor ?? "",
    authorUrl: previous?.asset.authorUrl ?? "",
    publisherRole: previous?.asset.publisherRole ?? "original_author",
    license: previous?.asset.license ?? {},
    licenseEdited: Boolean(previous),
    baseVersion: supportedBaseVersion(previous?.version.metadata?.familyVersion ?? previous?.asset.metadata?.familyVersion),
    label: previous?.version.label ?? "v1",
    series: previous?.asset.metadata?.series ?? "",
    group: previous?.asset.metadata?.group ?? "",
    cover: "",
    checksum: file?.sha256 ?? "",
    previousSubmissionId: assetId ? undefined : previous?.id,
    assetId: assetId ?? (previous?.operation === "new_version" ? previous.assetId : undefined),
  };
}

const DRAFT_KEY = "fabric.community.characterDrafts.v1";

export function loadDrafts(): Draft[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function storeDrafts(drafts: Draft[]) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
}

export const characterBaseVersions = Object.keys(engineVersions).sort((left, right) => left.localeCompare(right, "en", { numeric: true }));

function supportedBaseVersion(value: unknown) {
  const version = typeof value === "string" ? value.trim().toLowerCase() : "";
  return characterBaseVersions.find((candidate) => candidate.toLowerCase() === version);
}

export function draftBaseVersion(draft: Draft) {
  return supportedBaseVersion(draft.baseVersion ?? draft.pending?.body.asset.metadata.familyVersion);
}

export function validUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const isSha256 = (value: string) => /^[a-f0-9]{64}$/i.test(value.trim());
export const providerHash = (file: SourceFile) =>
  file.providerDigest?.algorithm.toLowerCase() === "sha256" && isSha256(file.providerDigest.value)
    ? file.providerDigest.value
    : undefined;

type PublicationRequest =
  | { action: "resolve"; url: string; revision?: string }
  | { action: "cover"; bytes: number[] }
  | { action: "submit"; key: string; body: SubmissionBody }
  | { action: "batch"; batchId: string; items: Array<{ key: string; body: SubmissionBody }> }
  | { action: "author"; id: string; cursor?: string }
  | { action: "owned"; cursor?: string }
  | { action: "mine"; state: ReviewState; page: number; limit: number; batch?: string }
  | { action: "withdraw"; id: string };

export function publication<T>(request: PublicationRequest) {
  return invoke<T>("community_publication", { request });
}

export async function prepareSubmission(draft: Draft, account: string, send = publication) {
  const baseVersion = draftBaseVersion(draft);
  if (!baseVersion) throw { code: "base_version_required" };
  if (draft.pending?.account === account && draft.pending.body.asset.metadata.familyVersion === baseVersion) return draft.pending;
  const selection = draft.selection;
  if (!selection || selection.account !== account || Date.parse(selection.expiresAt) <= Date.now()) {
    throw { code: "read_source" };
  }
  let coverUploadId: string | undefined;
  if (draft.cover) {
    const bytes = Array.from(atob(draft.cover.split(",")[1]), (character) => character.charCodeAt(0));
    coverUploadId = (await send<{ uploadId: string }>({ action: "cover", bytes })).uploadId;
  }

  const { file } = selection;
  const body: SubmissionBody = {
    operation: draft.assetId ? "new_version" : "create",
    assetId: draft.assetId,
    previousSubmissionId: draft.previousSubmissionId,
    coverUploadId,
    asset: {
      kind: "model",
      title: draft.title.trim(),
      description: draft.description.trim(),
      originalAuthor: draft.originalAuthor.trim(),
      authorUrl: draft.authorUrl.trim() || undefined,
      publisherRole: draft.publisherRole,
      upstreamUrl: selection.canonicalUrl,
      license: draft.license,
      metadata: {
        family: "gpt-sovits",
        familyVersion: baseVersion,
        format: "character_package",
        series: draft.series.trim() || undefined,
        group: draft.group.trim() || undefined,
        language: draft.language?.trim() || undefined,
      },
    },
    version: {
      label: draft.label.trim(),
      files: [{ path: file.path, role: "package", resolveId: selection.resolveId, sourceFileId: file.id, sha256: draft.checksum.trim() || undefined }],
      dependencies: [],
    },
  };
  return { account, key: crypto.randomUUID(), body };
}

export function publicationError(error: unknown, action: "resolve" | "submit" | "list") {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "unauthorized" || (code === "auth_required" && action !== "resolve")) return t("publication.signInRequired");
  if (action === "submit" && ["read_source", "conflict", "not_found"].includes(String(code))) return t("publication.readAgain");
  if (code === "source_changed") return t("publication.sourceChanged");
  if (code === "base_version_required") return t("publication.chooseBaseModel");
  if (code === "hash_mismatch") return t("publication.hashMismatch");
  if (code === "rate_limited") return t(action === "resolve" ? "publication.rateLimited" : "publication.retryQueued");
  if (action === "resolve" && (code === "auth_required" || code === "unsupported" || code === "not_found")) return t("publication.publicSource");
  return t("publication.requestFailed");
}
