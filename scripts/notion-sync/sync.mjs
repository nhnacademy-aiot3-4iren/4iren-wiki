import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const REPO = process.env.REPO;

if (!NOTION_TOKEN || !DATABASE_ID || !REPO) {
  throw new Error("NOTION_TOKEN, NOTION_DATABASE_ID, REPO env vars are required");
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

const MEMBERS = ["김태희", "신준식", "윤채영", "유대연", "이정민", "전유진", "전재나", "최이건", "황지원"];

// Notion 표시 이름이 정식 이름과 다른 경우 매핑 (성/이름 순서 뒤바뀜, 닉네임 등)
const NAME_ALIASES = {
  "이건 최": "최이건",
  "준식 신": "신준식",
  "NEW JEAN": "전유진",
  "김태히": "김태희",
};

const TYPE_MAP = [
  { match: /daily/i, label: "Daily", title: "Daily Scrum" },
  { match: /team/i, label: "Team", title: "Team Meeting" },
  { match: /weekly/i, label: "Weekly", title: "Weekly Meeting" },
];

function getTitle(prop) {
  return (prop?.title ?? []).map((t) => t.plain_text).join("").trim();
}

function getSelectName(prop) {
  return prop?.select?.name ?? prop?.status?.name ?? "";
}

function getPeopleNames(prop) {
  return (prop?.people ?? [])
    .map((p) => p.name)
    .filter(Boolean)
    .map((name) => NAME_ALIASES[name] ?? name);
}

function getRichText(prop) {
  return (prop?.rich_text ?? []).map((t) => t.plain_text).join("").trim();
}

function getIsoDate(prop) {
  return prop?.date?.start ?? "";
}

function getUrl(prop) {
  return prop?.url ?? "";
}

function toKoreanDate(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${y}년 ${m}월 ${d}일`;
}

function buildAttendeesBlock(attendeeNames) {
  return MEMBERS
    .map((name) => `- [${attendeeNames.includes(name) ? "x" : " "}] ${name}`)
    .join("\n");
}

function fallbackTitle(typeInfo, isoDate) {
  if (!isoDate) return `[${typeInfo.title}]`;
  const [y, m, d] = isoDate.split("-");
  if (typeInfo.label === "Weekly") return `[Weekly Scrum] ${isoDate}`;
  return `[${typeInfo.title}] ${y.slice(2)}.${m}.${d}`;
}

async function findSyncTargets() {
  // Upsert model: every row with 완료 checked is a sync target, whether or
  // not it already has a linked issue. ghIssueUpsert() decides create vs
  // update based on whether "GitHub Issue" is already filled in.
  const results = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: "완료", checkbox: { equals: true } },
      start_cursor: cursor,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function pageToMarkdownBody(pageId) {
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const mdString = n2m.toMarkdownString(mdBlocks);
  return (mdString.parent ?? "").trim();
}

async function writeTempBody(body) {
  const bodyFile = `/tmp/issue-body-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
  await writeFile(bodyFile, body, "utf-8");
  return bodyFile;
}

async function ghIssueCreate({ title, body, labels }) {
  const bodyFile = await writeTempBody(body);
  const args = ["issue", "create", "--repo", REPO, "--title", title, "--body-file", bodyFile];
  for (const label of labels) args.push("--label", label);
  const out = execFileSync("gh", args, { encoding: "utf-8" });
  return out.trim().split("\n").pop();
}

function issueNumberFromUrl(url) {
  return url.trim().split("/").pop();
}

function ghIssueView(issueNumber) {
  const out = execFileSync(
    "gh",
    ["issue", "view", issueNumber, "--repo", REPO, "--json", "title,body,state"],
    { encoding: "utf-8" }
  );
  return JSON.parse(out);
}

async function ghIssueUpdate({ issueNumber, title, body }) {
  const bodyFile = await writeTempBody(body);
  execFileSync(
    "gh",
    ["issue", "edit", issueNumber, "--repo", REPO, "--title", title, "--body-file", bodyFile],
    { encoding: "utf-8" }
  );
}

// Create the issue if the Notion row has no linked issue yet, otherwise
// update the existing issue in place only if the content actually changed.
async function ghIssueUpsert({ existingUrl, title, body, labels }) {
  if (!existingUrl) {
    const issueUrl = await ghIssueCreate({ title, body, labels });
    return { issueUrl, created: true, updated: false };
  }

  const issueNumber = issueNumberFromUrl(existingUrl);
  const current = ghIssueView(issueNumber);
  if (current.state === "CLOSED") {
    console.log(`Issue #${issueNumber} is closed, skipping update.`);
    return { issueUrl: existingUrl, created: false, updated: false };
  }
  if (current.title === title && current.body.trim() === body.trim()) {
    return { issueUrl: existingUrl, created: false, updated: false };
  }

  await ghIssueUpdate({ issueNumber, title, body });
  return { issueUrl: existingUrl, created: false, updated: true };
}

async function main() {
  const targets = await findSyncTargets();
  if (targets.length === 0) {
    console.log("No rows to sync.");
    return;
  }

  for (const page of targets) {
    const props = page.properties;
    const meetingTypeRaw = getSelectName(props["미팅 타입"]);
    const typeInfo = TYPE_MAP.find((t) => t.match.test(meetingTypeRaw));
    if (!typeInfo) {
      console.log(`Skip ${page.id}: unrecognized meeting type "${meetingTypeRaw}"`);
      continue;
    }

    const isoDate = getIsoDate(props["날짜"]);
    const dateKr = toKoreanDate(isoDate);
    const scrumMasterNames = getPeopleNames(props["스크럼 마스터"]);
    const scrumMaster = scrumMasterNames[0] ?? "";
    const attendeeNames = getPeopleNames(props["참석자"]);
    const time = getRichText(props["스크럼 진행시간"]);
    const title = getTitle(props["이름"]) || fallbackTitle(typeInfo, isoDate);

    const contentMd = await pageToMarkdownBody(page.id);

    const header = [
      "### Date", "", dateKr, "",
      "### Meeting Type", "", typeInfo.title, "",
      "### ScrumMaster", "", scrumMaster, "",
      "### 진행 시간", "", time, "",
      "### Attendees", "", buildAttendeesBlock(attendeeNames), "",
    ].join("\n");

    const body = `${header}\n${contentMd}`;
    const existingUrl = getUrl(props["GitHub Issue"]);

    const { issueUrl, created, updated } = await ghIssueUpsert({
      existingUrl,
      title,
      body,
      labels: ["Scrum", typeInfo.label],
    });

    if (created) {
      await notion.pages.update({
        page_id: page.id,
        properties: {
          "GitHub Issue": { url: issueUrl },
        },
      });
      console.log(`Created ${page.id} -> ${issueUrl}`);
    } else if (updated) {
      console.log(`Updated ${page.id} -> ${issueUrl}`);
    } else {
      console.log(`Unchanged ${page.id} -> ${issueUrl}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
