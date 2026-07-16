import { describe, expect, it } from "vitest";
import { buildSafeProfile, type ProfilePolicy } from "./build-profile.js";

const policy: ProfilePolicy = {
  schemaVersion: "profile-v1", targetChannels: ["new_grad_2027"],
  rolePriorities: [{ group: "product_web_ai_engineering", weight: 1 }],
  languages: [{ code: "ja", level: "JLPT N1" }],
  locations: {}, employment: {}, visa: {}, compensation: {},
};

describe("PII-safe Profile extraction", () => {
  it("extracts only allowlisted capability signals from a resume containing direct PII", () => {
    const html = `<body><h1>山田 太郎</h1><p>taro@example.com / 090-1234-5678 / 〒100-0001 東京都</p>
      <p>TypeScript React Next.js SwiftUI Unity 生成AI のプロジェクト経験</p></body>`;
    const profile = buildSafeProfile(html, policy);
    const serialized = JSON.stringify(profile);
    expect(profile.normalizedSkills).toEqual(expect.arrayContaining(["TypeScript", "React", "Next.js", "SwiftUI", "Unity", "AI"]));
    expect(serialized).not.toContain("山田");
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("090");
    expect(profile.piiPolicy.directPiiStored).toBe(false);
  });

  it("extracts allowlisted office, academic-affairs, research, and cross-cultural signals", () => {
    const html = `<body><p>総合科の事務員、職業学校の教務担当として勤務。</p>
      <p>中国語・日本語・英語を使い、異文化環境で聞き取り調査と文献調査を実施。</p></body>`;
    const profile = buildSafeProfile(html, policy);
    expect(profile.normalizedSkills).toEqual(expect.arrayContaining([
      "Office Administration", "Academic Affairs", "Qualitative Research", "Cross-cultural Communication",
    ]));
    expect(profile.experienceSignals).toEqual(expect.arrayContaining([
      "office_administration", "academic_affairs", "qualitative_research", "cross_cultural_communication",
    ]));
  });

  it("does not infer AI experience from an email provider name", () => {
    const profile = buildSafeProfile("<body><p>candidate@gmail.com</p><p>一般事務を担当</p></body>", policy);
    expect(profile.experienceSignals).not.toContain("ai_engineering");
    expect(profile.experienceSignals).toContain("office_administration");
  });
});
