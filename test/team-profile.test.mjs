import assert from "node:assert/strict";
import test from "node:test";

import { buildTeamCognitiveProfile } from "../src/team-profile.mjs";

const SAMPLE = `# 示例团队身份职责档案（人脉地图版 v6）

### 0.2 核心团队名单（按部门分组）

**平台研发部2人：**
示例用户、甲同事

### 1.1 组织架构

| 方向 | 负责人 | 核心成员 | 主要产品/项目 |
|---|---|---|---|
| 示例软件开发 | 示例用户（开发管理） | 甲同事 | 示例重构 |

### 1.2 核心项目矩阵

| 项目 | 负责人 | 状态 | 核心成员 |
|---|---|---|---|
| 示例重构 | 示例用户 | 开发中 | 甲同事 |

## 二、核心成员详细档案（含协作关系与求助指南）

### 2.1 示例用户（本人）

**角色定位**：软件开发管理者 / 核心开发

**教育背景**：不应进入路由的学校信息

**职责范围**：激光跟踪软件架构；通信协议接入

**负责模块**：通信标定、先扫后焊

**git仓库**：example_service、ExampleVisionUI

### 2.2 甲同事（飞书账号someone123）

**角色定位**：测试负责人

**技术背景与技术栈**：C++测试框架；弱网故障注入

**职责范围**：弱网测试；回归测试

**与示例用户的协作关系**：共同验证界面。

**什么问题可以找他**：弱网问题；测试用例

## 三、其他出现人员

### 3.1 有一定信息的人员

| 姓名 | 角色/职责 | 与示例用户的关系 | 什么问题可以找他 |
|---|---|---|---|
| 乙同事 | 硬件测试 | 硬件协作 | 相机测试 |

### 3.2 管理层与外部协作

| 姓名/称呼 | 角色 | 与示例用户的关系 | 什么问题可以找他 |
|---|---|---|---|
| 丙老师 | 资源审批 | 间接汇报 | 资源申请 |

### 4.1 核心协作群（16个）

| 群名 | 用途 | 核心成员 | 最早记录 |
|---|---|---|---|
| 软件开发 | 技术讨论 | 示例用户、甲同事 | 2026-07 |

### 4.2 示例用户的核心协作网络（按紧密程度排序）

| 紧密程度 | 人员 | 协作内容 | 沟通渠道 |
|---|---|---|---|
| 高 | 甲同事 | 弱网测试 | 单聊 |

### 4.3 示例用户的沟通风格总结

- 对同事：技术导向，说明证据。

本档案基于2026年8月27日可检索的企业内部资料生成。
`;
const OPTIONS = { ownerName: "示例用户", profileId: "example-team" };

test("team profile uses the generic graph schema for people and work routing", () => {
  const profile = buildTeamCognitiveProfile(SAMPLE, { ...OPTIONS, sourcePath: "docs/source.md" });
  assert.equal(profile.version, 1);
  assert.equal(profile.metadata.asOf, "2026-08-27");
  assert.ok(profile.entities.some((entity) => entity.canonicalKey === "person:甲同事"));
  assert.ok(profile.entities.some((entity) => entity.type === "Department"));
  assert.ok(profile.entities.some((entity) => entity.type === "Project" && entity.name === "示例重构"));
  assert.ok(profile.relations.some((relation) => relation.subject === "person:甲同事" && relation.predicate === "CAN_HELP_WITH"));
  assert.ok(profile.relations.some((relation) => relation.subject === "person:甲同事" && relation.predicate === "EXPERT_IN"));
  const identity = profile.entities.find((entity) => entity.type === "CommunicationIdentity" && entity.name === "someone123");
  assert.ok(identity);
  assert.ok(profile.relations.some((relation) => relation.subject === "person:甲同事"
    && relation.predicate === "IDENTIFIED_BY" && relation.object === identity.canonicalKey));
  assert.ok(profile.relations.some((relation) => relation.subject === "person:示例用户" && relation.predicate === "OWNS"));
  assert.ok(profile.entities.some((entity) => entity.canonicalKey === "document:example-team-v6"));
});

test("team profile excludes private narrative fields from structured routing", () => {
  const profile = buildTeamCognitiveProfile(SAMPLE, OPTIONS);
  const serialized = JSON.stringify(profile);
  assert.equal(serialized.includes("不应进入路由的学校信息"), false);
  assert.equal(serialized.includes("教育背景"), false);
  assert.ok(profile.metadata.excludedFromRouting.includes("education"));
});

test("team owner and department relations come from this document, not a developer identity", () => {
  const input = SAMPLE.replaceAll("示例用户", "另一用户")
    .replace("### 1.1", "**跨部门共同领导：**\n领导甲\n\n### 1.1");
  const profile = buildTeamCognitiveProfile(input, { ownerName: "另一用户", profileId: "other-team" });
  assert.equal(profile.entities.filter(entity => entity.metadata.isProfileOwner).length, 1);
  assert.equal(profile.entities.find(entity => entity.metadata.isProfileOwner).name, "另一用户");
  const leads = profile.relations.filter(relation => relation.predicate === "LEADS");
  assert.equal(leads.length, 1);
  assert.equal(leads[0].object, "department:平台研发部");
  assert.ok(profile.relations.some(relation => relation.subject === "person:甲同事"
    && relation.predicate === "COLLABORATES_WITH" && relation.object === "person:另一用户"));
  assert.doesNotMatch(JSON.stringify(profile), /示例人员19|示例公司|示例实验组/);
});

test("missing or conflicting profile ownership cannot silently seed another person's identity", () => {
  assert.throws(() => buildTeamCognitiveProfile(SAMPLE), /ownerName/);
  assert.throws(() => buildTeamCognitiveProfile(SAMPLE, { ...OPTIONS, ownerName: "不存在" }), /ownerName/);
  assert.throws(() => buildTeamCognitiveProfile(SAMPLE, { ...OPTIONS, ownerName: "甲同事" }), /conflicts/);
  assert.throws(() => buildTeamCognitiveProfile(SAMPLE, { ownerName: OPTIONS.ownerName }), /profileId/);
});
