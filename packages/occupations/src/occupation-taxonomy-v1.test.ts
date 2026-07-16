import { describe, expect, it } from "vitest";
import { classifyOccupation, occupationFamilyFacets, rolePriorityWeight } from "./occupation-taxonomy-v1.js";

describe("occupation-taxonomy-v1", () => {
  it.each([
    ["iOS Engineer (Swift)", "it_web_software", "mobile_app_engineer", ["iOS"]],
    ["Unityゲーム開発エンジニア", "it_web_software", "game_engineer", ["Unity"]],
    ["生成AI・機械学習エンジニア", "it_web_software", "data_ai_ml_engineer", ["AI・機械学習"]],
    ["人事・労務・採用担当", "corporate_management", "human_resources_recruiting", []],
    ["一般事務スタッフ（中国語を活かせます）", "office_administration", "general_office_administration", ["中国語"]],
    ["学校法人の教務事務", "childcare_education", "academic_affairs_school_operations", []],
    ["日本語・英語・中国語の通訳・翻訳", "professional_consulting_finance_real_estate", "interpreter_translator", ["中国語", "英語"]],
    ["BD - Business Development（オープン採用）", "sales_customer_success", "corporate_sales", []],
    ["Data Infrastructure Engineer", "it_web_software", "data_ai_ml_engineer", []],
    ["QA Engineer (MIS)", "it_web_software", "qa_test_engineer", []],
    ["Salesforce Delivery Manager", "it_web_software", "pm_pdm_it_consulting", []],
    ["Organic Search Manager", "planning_marketing_management", "marketing_growth", []],
    ["KFJP_CG - 法務ジェネラリスト", "corporate_management", "legal_compliance", []],
    ["プロジェクトマネージャ―", "it_web_software", "pm_pdm_it_consulting", []],
    ["【正社員】工具メーカーの営業スタッフ", "sales_customer_success", "general_sales", []],
  ])("classifies %s without promoting skills to occupation families", (title, family, role, tags) => {
    const result = classifyOccupation({ title });
    expect(result.primary.family).toBe(family);
    expect(result.primary.role).toBe(role);
    expect(result.specialtyTags).toEqual(expect.arrayContaining(tags));
    expect(result.confidence).toBe("high");
  });

  it("uses description only as a lower-confidence fallback", () => {
    const result = classifyOccupation({ title: "総合職", descriptionText: "法人営業として既存顧客を担当します" });
    expect(result.primary.family).toBe("sales_customer_success");
    expect(result.confidence).toBe("medium");
  });

  it("does not infer a specific occupation from incidental terms in a normal job description", () => {
    const result = classifyOccupation({
      title: "Treasury Operations Lead",
      descriptionText: "採用チームやiOSエンジニアと連携し、deliveryを支援します",
    });
    expect(result.primary.family).toBe("other");
    expect(result.confidence).toBe("low");
  });

  it("does not use an ambiguous multi-family description as a generic-title fallback", () => {
    const result = classifyOccupation({ title: "オープンポジション", descriptionText: "法人営業、人事・採用、フロントエンドエンジニアの候補があります" });
    expect(result.primary.family).toBe("other");
  });

  it("returns a versioned unclassified result instead of guessing", () => {
    const result = classifyOccupation({ title: "オープンポジション" });
    expect(result.primary.family).toBe("other");
    expect(result.confidence).toBe("low");
    expect(result.taxonomyVersion).toBe("occupation-taxonomy-v1");
  });

  it("counts secondary families once per job", () => {
    const mixed = classifyOccupation({ title: "Webデザイナー兼フロントエンドエンジニア" });
    const facets = occupationFamilyFacets([mixed]);
    expect(facets.find((value) => value.id === "creative_design_media")?.count).toBe(1);
    expect(facets.find((value) => value.id === "it_web_software")?.count).toBe(1);
  });

  it("keeps legacy Profile groups compatible while preferring taxonomy role ids", () => {
    const office = classifyOccupation({ title: "一般事務" });
    expect(rolePriorityWeight(office, new Map([["office_administration", 0.8]]))).toBe(0.8);
    expect(rolePriorityWeight(office, new Map([["general_office_administration", 1]]))).toBe(1);
  });
});
