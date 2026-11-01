import { createHash } from "node:crypto";

const PERSON_SPLIT = /[、，,;+＋/]|\s+和\s+|\s+与\s+/u;

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function keyPart(value) {
  return sha256(value).slice(0, 16);
}

function cleanInline(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAnnotation(value) {
  return cleanInline(value)
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function splitPeople(value) {
  return cleanInline(value)
    .replace(/[（(][^）)]*[）)]/g, "")
    .split(PERSON_SPLIT)
    .map(stripAnnotation)
    .filter((name) => name && name !== "-" && name !== "全员" && name !== "其他人")
    .filter((name) => /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]{1,19}$/u.test(name));
}

function splitItems(value, maxLength = 220) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .split(/\n|；|;/)
    .flatMap((line) => line.split(/(?<=[。！？])/u))
    .map((line) => cleanInline(line).replace(/^(?:-|\d+[.、)])\s*/, ""))
    .filter(Boolean)
    .map((item) => item.slice(0, maxLength));
}

function safeRoutingItems(value) {
  return splitItems(value).filter((item) => !/(?:登录码|密码|密钥|私钥|共享[^。；]*(?:账号|凭据))/i.test(item));
}

function safeRoutingSummary(value, maxLength = 500) {
  return safeRoutingItems(value).join("；").slice(0, maxLength);
}

function section(markdown, headingPattern, nextHeadingLevel = 3) {
  const match = headingPattern.exec(markdown);
  if (!match) return "";
  const start = match.index + match[0].length;
  const next = markdown.slice(start).search(new RegExp(`^#{1,${nextHeadingLevel}}\\s+`, "m"));
  return markdown.slice(start, next < 0 ? markdown.length : start + next);
}

function field(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\*\\*${escaped}\\*\\*(?:（[^）\\n]*）)?\\s*[：:]\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*[^\\n]+\\*\\*|\\n---|\\n###|$)`,
    "u",
  ).exec(body);
  return match?.[1]?.trim() ?? "";
}

function parseTable(markdownSection) {
  const lines = markdownSection.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  if (lines.length < 2) return [];
  const cells = (line) => line.split("|").slice(1, -1).map(cleanInline);
  const headers = cells(lines[0]);
  const dataLines = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[1]) ? lines.slice(2) : lines.slice(1);
  return dataLines.map(cells).filter((row) => row.length === headers.length).map((row) => (
    Object.fromEntries(headers.map((header, index) => [header, row[index]]))
  ));
}

function newestAsOf(markdown) {
  const matches = [...markdown.matchAll(/(20\d{2})年(\d{1,2})月(\d{1,2})日/g)];
  if (!matches.length) return null;
  return matches
    .map((match) => `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`)
    .sort()
    .at(-1);
}

function profileVersion(markdown) {
  const match = /^#\s+[^\n]*身份职责档案[^\n]*?\bv(\d+)\b/im.exec(markdown);
  return match ? Number(match[1]) : null;
}

class ProfileBuilder {
  constructor(metadata) {
    this.metadata = metadata;
    this.entities = new Map();
    this.relations = new Map();
  }

  entity(canonicalKey, type, name, input = {}) {
    const previous = this.entities.get(canonicalKey) ?? {};
    const aliases = [...new Set([...(previous.aliases ?? []), ...(input.aliases ?? [])].filter(Boolean))];
    this.entities.set(canonicalKey, {
      canonicalKey,
      type,
      name: previous.name ?? name,
      ...(input.summary || previous.summary ? { summary: input.summary ?? previous.summary } : {}),
      ...(aliases.length ? { aliases } : {}),
      metadata: { ...(previous.metadata ?? {}), ...(input.metadata ?? {}), sourceAsOf: this.metadata.asOf },
    });
    return canonicalKey;
  }

  person(name, input = {}) {
    const normalized = stripAnnotation(name);
    return this.entity(`person:${normalized}`, "Person", normalized, input);
  }

  department(name) {
    const display = cleanInline(name);
    const shortName = display.replace(/[（(].*$/, "").replace(/\d+人.*$/, "").trim();
    return this.entity(`department:${shortName}`, "Department", display, {
      aliases: display === shortName ? [] : [shortName],
    });
  }

  named(type, prefix, name, input = {}) {
    const display = cleanInline(name);
    return this.entity(`${prefix}:${keyPart(display)}`, type, display, input);
  }

  relation(subject, predicate, object, input = {}) {
    if (!subject || !predicate || !object) return;
    const key = `${subject}\0${predicate}\0${object}\0${input.scopeKey ?? ""}`;
    const previous = this.relations.get(key);
    this.relations.set(key, {
      subject,
      predicate,
      object,
      confidence: Math.max(previous?.confidence ?? 0, input.confidence ?? 0.9),
      ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.validTo ? { validTo: input.validTo } : {}),
      metadata: { ...(previous?.metadata ?? {}), ...(input.metadata ?? {}), sourceAsOf: this.metadata.asOf },
    });
  }

  finish() {
    return {
      version: 1,
      title: this.metadata.title,
      metadata: this.metadata,
      entities: [...this.entities.values()].sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey, "zh-CN")),
      relations: [...this.relations.values()].sort((a, b) => (
        `${a.subject}:${a.predicate}:${a.object}`.localeCompare(`${b.subject}:${b.predicate}:${b.object}`, "zh-CN")
      )),
    };
  }
}

function addResponsibility(builder, personKey, text, sourceSection) {
  for (const item of splitItems(text)) {
    const responsibility = builder.named("Responsibility", "responsibility", item);
    builder.relation(personKey, "RESPONSIBLE_FOR", responsibility, {
      metadata: { sourceSection, routingUse: "ownership_evidence" },
    });
  }
}

function addTopics(builder, personKey, text, predicate, sourceSection) {
  for (const item of splitItems(text).flatMap((part) => part.split(/[、，,]/).map(cleanInline)).filter(Boolean)) {
    const topic = builder.named("KnowledgeTopic", "topic", item);
    builder.relation(personKey, predicate, topic, {
      metadata: { sourceSection, routingUse: "knowledge_route" },
    });
  }
}

function addMemberProfiles(builder, markdown) {
  const matches = [...markdown.matchAll(/^###\s+2\.\d+\s+(.+)$/gm)];
  const ownerName = builder.metadata.ownerName;
  const self = builder.person(ownerName, { metadata: { isProfileOwner: true } });
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? markdown.search(/^##\s+三、/m);
    const body = markdown.slice(bodyStart, bodyEnd < 0 ? markdown.length : bodyEnd);
    const heading = cleanInline(match[1]);
    const name = stripAnnotation(heading);
    if (!name) continue;
    const roleText = cleanInline(field(body, "角色定位"));
    const person = builder.person(name, {
      summary: roleText || undefined,
      aliases: heading === name ? [] : [heading],
      metadata: { profileSection: `2.${index + 1}`, isProfileOwner: name === ownerName },
    });

    for (const roleName of roleText.split(/[／/]/).map(cleanInline).filter(Boolean)) {
      const role = builder.named("Role", "role", roleName);
      builder.relation(person, "HAS_ROLE", role, { metadata: { sourceSection: `2.${index + 1}` } });
    }

    for (const departmentName of splitItems(field(body, "部门"))) {
      const department = builder.department(departmentName);
      builder.relation(person, "MEMBER_OF", department, { metadata: { sourceSection: `2.${index + 1}` } });
    }

    addResponsibility(builder, person, field(body, "职责范围"), `2.${index + 1}`);
    addTopics(builder, person, field(body, "负责模块"), "RESPONSIBLE_FOR", `2.${index + 1}`);
    addTopics(builder, person, field(body, "技术背景与技术栈"), "EXPERT_IN", `2.${index + 1}`);
    addTopics(builder, person, field(body, "技术栈与专长"), "EXPERT_IN", `2.${index + 1}`);
    addTopics(builder, person, field(body, "什么问题可以找他"), "CAN_HELP_WITH", `2.${index + 1}`);

    const repositories = field(body, "git仓库");
    for (const repoName of cleanInline(repositories).split(/[、，,]/).map(cleanInline).filter(Boolean)) {
      const repository = builder.named("CodeRepository", "repository", repoName);
      builder.relation(person, "MAINTAINS", repository, { metadata: { sourceSection: `2.${index + 1}` } });
    }

    const collaboration = safeRoutingSummary(field(body, `与${ownerName}的协作关系`));
    if (name !== ownerName && collaboration) {
      builder.relation(person, "COLLABORATES_WITH", self, {
        metadata: { sourceSection: `2.${index + 1}`, summary: collaboration },
      });
    }

    const identity = heading.match(/(?:飞书账号|用户)\s*([A-Za-z0-9_-]+)/u)?.[1];
    if (identity) {
      const identityKey = builder.named("CommunicationIdentity", "communication-identity", identity, {
        metadata: { platform: "feishu", locator: identity },
      });
      builder.relation(person, "IDENTIFIED_BY", identityKey, { metadata: { sourceSection: `2.${index + 1}` } });
    }
  }
}

function addDepartmentMemberships(builder, markdown) {
  const content = section(markdown, /^###\s+0\.2\s+.*$/m);
  const departments = [];
  for (const match of content.matchAll(/^\*\*([^*：:]+?)(?:\d+人)?[：:]\*\*\s*\n([^\n]+)/gm)) {
    if (cleanInline(match[1]) === "跨部门共同领导") continue;
    const department = builder.department(match[1]);
    departments.push(department);
    for (const name of splitPeople(match[2])) {
      builder.relation(builder.person(name), "MEMBER_OF", department, { metadata: { sourceSection: "0.2" } });
    }
  }

  const leaders = /\*\*跨部门共同领导[：:]\*\*\s*\n([^\n]+)/m.exec(content)?.[1] ?? "";
  for (const leaderName of splitPeople(leaders.split(/[—-]/)[0])) {
    const leader = builder.person(leaderName);
    for (const department of departments) {
      builder.relation(leader, "LEADS", department, { metadata: { sourceSection: "0.2" } });
    }
  }
}

function addOrganization(builder, markdown) {
  const content = section(markdown, /^###\s+1\.1\s+.*$/m);
  for (const row of parseTable(content)) {
    const direction = builder.named("ResponsibilityArea", "responsibility-area", row["方向"]);
    for (const ownerName of splitPeople(row["负责人"])) {
      builder.relation(builder.person(ownerName), "RESPONSIBLE_FOR", direction, { metadata: { sourceSection: "1.1" } });
    }
    for (const memberName of splitPeople(row["核心成员"])) {
      builder.relation(builder.person(memberName), "CONTRIBUTES_TO", direction, { metadata: { sourceSection: "1.1" } });
    }
    for (const projectName of cleanInline(row["主要产品/项目"]).split(/[、，,]/).filter(Boolean)) {
      builder.relation(direction, "COVERS", builder.named("Project", "project", projectName), { metadata: { sourceSection: "1.1" } });
    }
  }
}

function addProjects(builder, markdown, asOf) {
  const content = section(markdown, /^###\s+1\.2\s+.*$/m);
  for (const row of parseTable(content)) {
    const project = builder.named("Project", "project", row["项目"], {
      metadata: { statusAsOf: asOf, needsRefresh: true },
    });
    for (const ownerName of splitPeople(row["负责人"])) {
      builder.relation(builder.person(ownerName), "OWNS", project, { metadata: { sourceSection: "1.2" } });
    }
    for (const memberName of splitPeople(row["核心成员"])) {
      builder.relation(builder.person(memberName), "CONTRIBUTES_TO", project, { metadata: { sourceSection: "1.2" } });
    }
    if (cleanInline(row["状态"])) {
      const status = builder.named("ProjectStatus", "project-status", row["状态"], {
        metadata: { asOf, needsRefresh: true },
      });
      builder.relation(project, "HAS_STATUS", status, {
        validFrom: asOf ? `${asOf}T00:00:00.000Z` : undefined,
        metadata: { sourceSection: "1.2", temporal: true, needsRefresh: true },
      });
    }
  }
}

function addOtherPeople(builder, markdown) {
  for (const sectionNumber of ["3.1", "3.2"]) {
    const content = section(markdown, new RegExp(`^###\\s+${sectionNumber.replace(".", "\\.")}\\s+.*$`, "m"));
    for (const row of parseTable(content)) {
      const rawName = row["姓名"] ?? row["姓名/称呼"];
      for (const name of splitPeople(rawName)) {
        const role = row["角色/职责"] ?? row["角色"];
        const person = builder.person(name, { summary: cleanInline(role) || undefined });
        addResponsibility(builder, person, role, sectionNumber);
        addTopics(builder, person, row["什么问题可以找他"], "CAN_HELP_WITH", sectionNumber);
        const relationship = safeRoutingSummary(row[`与${builder.metadata.ownerName}的关系`]);
        if (relationship) {
          builder.relation(person, "COLLABORATES_WITH", builder.person(builder.metadata.ownerName), {
            metadata: { sourceSection: sectionNumber, summary: relationship },
          });
        }
      }
    }
  }
}

function addGroups(builder, markdown) {
  const content = section(markdown, /^###\s+4\.1\s+.*$/m);
  for (const row of parseTable(content)) {
    const channel = builder.named("CommunicationChannel", "channel", row["群名"], {
      summary: cleanInline(row["用途"]),
      metadata: { platform: "feishu", earliestRecord: cleanInline(row["最早记录"]) || null },
    });
    for (const memberName of splitPeople(row["核心成员"])) {
      builder.relation(builder.person(memberName), "PARTICIPATES_IN", channel, { metadata: { sourceSection: "4.1" } });
    }
  }
}

function addCollaborationNetwork(builder, markdown) {
  const content = section(markdown, /^###\s+4\.2\s+.*$/m);
  const self = builder.person(builder.metadata.ownerName, { metadata: { isProfileOwner: true } });
  for (const row of parseTable(content)) {
    for (const name of splitPeople(row["人员"])) {
      const person = builder.person(name);
      addTopics(builder, person, row["协作内容"], "CAN_HELP_WITH", "4.2");
      builder.relation(self, "COLLABORATES_WITH", person, {
        metadata: {
          sourceSection: "4.2",
          closeness: cleanInline(row["紧密程度"]),
          summary: cleanInline(row["协作内容"]).slice(0, 500),
          channel: cleanInline(row["沟通渠道"]),
        },
      });
    }
  }
}

function addCommunicationPreferences(builder, markdown) {
  const content = section(markdown, /^###\s+4\.3\s+.*$/m);
  const self = builder.person(builder.metadata.ownerName, { metadata: { isProfileOwner: true } });
  for (const item of safeRoutingItems(content)) {
    const preference = builder.named("CommunicationPreference", "communication-preference", item, {
      metadata: { usage: "drafting_only" },
    });
    builder.relation(self, "PREFERS_COMMUNICATION_STYLE", preference, {
      metadata: { sourceSection: "4.3", usage: "drafting_only" },
    });
  }
}

export function buildTeamCognitiveProfile(markdown, options = {}) {
  const normalized = String(markdown ?? "").replace(/\r\n/g, "\n");
  const title = /^#\s+([^\n]*身份职责档案[^\n]*)$/m.exec(normalized)?.[1]?.trim();
  if (!title) {
    throw new Error("Unsupported team profile document.");
  }
  const ownerName = stripAnnotation(options.ownerName);
  const members = [...normalized.matchAll(/^###\s+2\.\d+\s+(.+)$/gm)].map(match => stripAnnotation(match[1]));
  if (!ownerName || !members.includes(ownerName)) throw new Error("Provide an explicit ownerName matching a member in the source document.");
  const declaredOwners = [...normalized.matchAll(/^###\s+2\.\d+\s+(.+)$/gm)]
    .filter(match => /[（(]本人[）)]/.test(match[1])).map(match => stripAnnotation(match[1]));
  if (declaredOwners.some(name => name !== ownerName)) throw new Error("ownerName conflicts with the source document's explicit owner.");
  const profileId = String(options.profileId ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(profileId)) throw new Error("Provide a stable profileId; unrelated profiles must use different IDs.");
  const asOf = newestAsOf(normalized);
  const version = profileVersion(normalized);
  const builder = new ProfileBuilder({
    schema: "team-cognitive-profile/v1",
    title,
    ownerName,
    profileId,
    asOf,
    generatedAt: options.generatedAt ?? null,
    sourcePath: options.sourcePath ?? null,
    sourceSha256: sha256(normalized),
    visibility: "repository-controlled",
    retrievalPolicy: "graph-subset-only",
    excludedFromRouting: ["education", "career_history", "management_evaluation", "chat_quotes", "team_culture"],
  });
  const documentVersion = version ? `v${version}` : "未标注版本";
  builder.entity(`document:${profileId}-${version ? `v${version}` : "unversioned"}`, "Document", title, {
    metadata: { sourcePath: options.sourcePath ?? null, sourceSha256: sha256(normalized), documentVersion },
  });

  addDepartmentMemberships(builder, normalized);
  addOrganization(builder, normalized);
  addProjects(builder, normalized, asOf);
  addMemberProfiles(builder, normalized);
  addOtherPeople(builder, normalized);
  addGroups(builder, normalized);
  addCollaborationNetwork(builder, normalized);
  addCommunicationPreferences(builder, normalized);
  return builder.finish();
}
