#!/usr/bin/env python3
import json
import os
import re
import subprocess

TYPE_ORDER = ["Daily", "Team", "Weekly"]
TYPE_LABELS = {
    "Daily": "🟢 Daily Scrum",
    "Team": "🟣 Team Meeting",
    "Weekly": "🔵 Weekly Scrum",
}


def fetch_issues(repo):
    result = subprocess.run(
        [
            "gh", "issue", "list", "--repo", repo, "--label", "Scrum",
            "--state", "all", "--limit", "500",
            "--json", "number,title,url,state,labels,body,createdAt",
        ],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def extract_field(body, label):
    if not body:
        return ""
    match = re.search(rf"### {re.escape(label)}[ \t]*\n\n([^\n]*)", body)
    if not match:
        return ""
    value = match.group(1).strip()
    return "" if value == "_No response_" else value


def main():
    repo = os.environ["REPO"]
    issues = fetch_issues(repo)

    grouped = {k: [] for k in TYPE_ORDER}
    for issue in issues:
        label_names = {label["name"] for label in issue["labels"]}
        kind = next((k for k in TYPE_ORDER if k in label_names), None)
        if kind is None:
            continue
        date = extract_field(issue["body"], "Date") or issue["createdAt"][:10]
        scrum_master = extract_field(issue["body"], "ScrumMaster")
        status = "🟢 Open" if issue["state"] == "OPEN" else "⚪ Closed"
        grouped[kind].append({
            "date": date,
            "title": issue["title"],
            "url": issue["url"],
            "scrum_master": scrum_master,
            "status": status,
        })

    for items in grouped.values():
        items.sort(key=lambda x: x["date"], reverse=True)

    lines = [
        "# 🗓 회의록",
        "",
        "> 이 페이지는 GitHub Actions가 `Scrum` 라벨이 붙은 이슈를 기반으로 자동 생성합니다. 직접 수정한 내용은 다음 갱신 때 덮어써집니다.",
        "",
    ]
    for kind in TYPE_ORDER:
        items = grouped[kind]
        lines.append(f"## {TYPE_LABELS[kind]}")
        lines.append("")
        if not items:
            lines.append("_아직 등록된 이슈가 없습니다._")
            lines.append("")
            continue
        lines.append("| 날짜 | 제목 | 스크럼마스터 | 상태 |")
        lines.append("| --- | --- | --- | --- |")
        for item in items:
            lines.append(
                f"| {item['date']} | [{item['title']}]({item['url']}) | "
                f"{item['scrum_master']} | {item['status']} |"
            )
        lines.append("")

    with open("회의록.md", "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    main()
