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
  return (prop?.people ?? []).map((p) => p.name).filter(Boolean);
}

function getRichText(prop) {
  return (prop?.rich_text ?? []).map((t) => t.plain_text).join("").trim();
}

function getIsoDate(prop) {
  return prop?.date?.start ?? "";
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
  const results = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        and: [
          { property: "완료", checkbox: { equals: true } },
          { property: "GitHub Issue", url: { is_empty: true } },
        ],
      },
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

function ghIssueCreate({ title, body, labels }) {
  const bodyFile = `/tmp/issue-body-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
  return writeFile(bodyFile, body, "utf-8").then(() => {
    const args = ["issue", "create", "--repo", REPO, "--title", title, "--body-file", bodyFile];
    for (const label of labels) args.push("--label", label);
    const out = execFileSync("gh", args, { encoding: "utf-8" });
    return out.trim().split("\n").pop();
  });
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

    const issueUrl = await ghIssueCreate({
      title,
      body,
      labels: ["Scrum", typeInfo.label],
    });

    await notion.pages.update({
      page_id: page.id,
      properties: {
        "GitHub Issue": { url: issueUrl },
      },
    });

    console.log(`Synced ${page.id} -> ${issueUrl}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
