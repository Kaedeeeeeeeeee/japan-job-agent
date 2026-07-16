export const OCCUPATION_TAXONOMY_VERSION = "occupation-taxonomy-v1";

export const OCCUPATION_TAXONOMY = [
  { id: "sales_customer_success", label: "営業・カスタマーサクセス", roles: [
    { id: "corporate_sales", label: "法人営業" },
    { id: "personal_sales", label: "個人営業" },
    { id: "inside_sales", label: "インサイドセールス" },
    { id: "account_management", label: "アカウント管理・既存営業" },
    { id: "customer_success_support", label: "カスタマーサクセス・サポート" },
    { id: "recruitment_consultant", label: "人材コーディネーター" },
    { id: "technical_sales", label: "技術営業・プリセールス" },
    { id: "sales_management", label: "営業企画・営業管理" },
    { id: "general_sales", label: "その他営業" },
  ] },
  { id: "planning_marketing_management", label: "企画・マーケティング・経営", roles: [
    { id: "product_service_planning", label: "商品・サービス企画" },
    { id: "marketing_growth", label: "マーケティング・グロース" },
    { id: "business_planning_strategy", label: "経営・事業企画" },
    { id: "pr_communications", label: "広報・PR" },
    { id: "executive_management", label: "経営・管理職" },
  ] },
  { id: "corporate_management", label: "管理・コーポレート", roles: [
    { id: "human_resources_recruiting", label: "人事・採用・労務" },
    { id: "general_affairs", label: "総務" },
    { id: "accounting_finance", label: "経理・財務・会計" },
    { id: "legal_compliance", label: "法務・コンプライアンス" },
    { id: "procurement_supply_chain", label: "購買・調達・SCM" },
    { id: "internal_audit_ir", label: "内部監査・IR" },
  ] },
  { id: "office_administration", label: "事務・アシスタント", roles: [
    { id: "general_office_administration", label: "一般事務・庶務" },
    { id: "sales_office_assistant", label: "営業事務・営業アシスタント" },
    { id: "trade_international_office", label: "貿易・海外事務" },
    { id: "medical_office", label: "医療事務" },
    { id: "reception_secretary", label: "受付・秘書" },
    { id: "data_entry_operations", label: "データ入力・オペレーション" },
  ] },
  { id: "it_web_software", label: "IT・Web・ソフトウェア", roles: [
    { id: "frontend_engineer", label: "フロントエンドエンジニア" },
    { id: "backend_engineer", label: "バックエンドエンジニア" },
    { id: "fullstack_engineer", label: "フルスタックエンジニア" },
    { id: "mobile_app_engineer", label: "モバイルアプリエンジニア" },
    { id: "data_ai_ml_engineer", label: "データ・AI・機械学習" },
    { id: "infrastructure_cloud_sre", label: "インフラ・クラウド・SRE" },
    { id: "network_telecom_engineer", label: "ネットワーク・通信" },
    { id: "security_engineer", label: "セキュリティ" },
    { id: "qa_test_engineer", label: "QA・テスト" },
    { id: "internal_it_support", label: "社内SE・ITサポート" },
    { id: "embedded_control_engineer", label: "組み込み・制御" },
    { id: "pm_pdm_it_consulting", label: "PM・PdM・ITコンサル" },
    { id: "game_engineer", label: "ゲームエンジニア" },
    { id: "general_software_engineer", label: "SE・プログラマー" },
  ] },
  { id: "creative_design_media", label: "クリエイティブ・デザイン・メディア", roles: [
    { id: "ui_ux_web_designer", label: "UI/UX・Webデザイナー" },
    { id: "graphic_cg_designer", label: "グラフィック・CGデザイナー" },
    { id: "game_creative", label: "ゲーム企画・クリエイティブ" },
    { id: "content_editor_writer", label: "編集・ライター・コンテンツ" },
    { id: "video_audio_production", label: "映像・音響・制作" },
    { id: "industrial_spatial_design", label: "プロダクト・空間デザイン" },
  ] },
  { id: "engineering_research", label: "技術・研究開発", roles: [
    { id: "mechanical_engineering", label: "機械・メカトロ" },
    { id: "electrical_electronics_semiconductor", label: "電気・電子・半導体" },
    { id: "chemical_materials_engineering", label: "化学・素材" },
    { id: "food_biotech_engineering", label: "食品・バイオ" },
    { id: "research_development", label: "研究・R&D" },
    { id: "quality_production_engineering", label: "品質・生産技術" },
  ] },
  { id: "architecture_construction_facilities", label: "建築・土木・設備・プラント", roles: [
    { id: "architecture_design", label: "建築設計" },
    { id: "civil_engineering", label: "土木・測量" },
    { id: "construction_management", label: "施工管理" },
    { id: "facilities_plant_engineering", label: "設備・プラント" },
  ] },
  { id: "retail_service_hospitality", label: "販売・サービス・飲食・旅行", roles: [
    { id: "retail_store_operations", label: "販売・店舗運営" },
    { id: "food_service", label: "飲食・調理" },
    { id: "hotel_travel_leisure", label: "ホテル・旅行・レジャー" },
    { id: "beauty_wellness", label: "美容・ウェルネス" },
    { id: "general_customer_service", label: "接客・サービス" },
  ] },
  { id: "professional_consulting_finance_real_estate", label: "専門職・コンサル・金融・不動産", roles: [
    { id: "management_consultant", label: "経営・専門コンサルタント" },
    { id: "finance_investment_insurance", label: "金融・投資・保険" },
    { id: "real_estate_professional", label: "不動産専門職" },
    { id: "licensed_legal_accounting_professional", label: "士業・法務専門職" },
    { id: "interpreter_translator", label: "通訳・翻訳" },
  ] },
  { id: "medical_healthcare", label: "医療・看護・保健", roles: [
    { id: "doctor_dentist_veterinarian", label: "医師・歯科医師・獣医師" },
    { id: "nurse_midwife_public_health", label: "看護師・保健師・助産師" },
    { id: "pharmacist", label: "薬剤師" },
    { id: "medical_technologist_therapist", label: "医療技術・リハビリ" },
    { id: "clinical_research_regulatory", label: "臨床開発・薬事" },
  ] },
  { id: "welfare_care", label: "福祉・介護", roles: [
    { id: "care_worker", label: "介護職・ヘルパー" },
    { id: "social_worker_support", label: "相談員・生活支援" },
    { id: "care_management", label: "ケアマネジメント・施設運営" },
  ] },
  { id: "childcare_education", label: "保育・教育", roles: [
    { id: "academic_affairs_school_operations", label: "教務・学校運営" },
    { id: "teacher_lecturer_instructor", label: "教師・講師・インストラクター" },
    { id: "childcare_kindergarten", label: "保育士・幼稚園教諭" },
    { id: "student_support_career", label: "学生支援・キャリア支援" },
  ] },
  { id: "manufacturing_maintenance_skilled", label: "製造・整備・技能", roles: [
    { id: "manufacturing_operator", label: "製造・工場オペレーター" },
    { id: "maintenance_mechanic", label: "整備・メンテナンス" },
    { id: "skilled_construction_worker", label: "技能工・工事作業" },
  ] },
  { id: "logistics_transport_warehouse", label: "物流・運輸・倉庫", roles: [
    { id: "logistics_warehouse", label: "物流・倉庫管理" },
    { id: "driver_delivery", label: "ドライバー・配送" },
    { id: "transport_operations", label: "鉄道・航空・運輸" },
  ] },
  { id: "public_organizations", label: "公務・団体", roles: [
    { id: "government_public_service", label: "公務員" },
    { id: "association_nonprofit_staff", label: "団体・NPO職員" },
  ] },
  { id: "security_cleaning_agriculture", label: "警備・清掃・農林水産", roles: [
    { id: "security_safety", label: "警備・保安" },
    { id: "cleaning_facility_service", label: "清掃・施設サービス" },
    { id: "agriculture_forestry_fisheries", label: "農林水産" },
  ] },
  { id: "other", label: "その他・分類未確定", roles: [
    { id: "other_unclassified", label: "その他・分類未確定" },
  ] },
] as const;

export type OccupationFamilyId = typeof OCCUPATION_TAXONOMY[number]["id"];
export type OccupationRoleId = typeof OCCUPATION_TAXONOMY[number]["roles"][number]["id"];

export interface OccupationSelection {
  family: OccupationFamilyId;
  familyLabel: string;
  role: OccupationRoleId;
  roleLabel: string;
}

export interface OccupationClassification {
  taxonomyVersion: typeof OCCUPATION_TAXONOMY_VERSION;
  primary: OccupationSelection;
  secondary: OccupationSelection[];
  specialtyTags: string[];
  confidence: "high" | "medium" | "low";
}

interface ClassificationRule {
  family: OccupationFamilyId;
  role: OccupationRoleId;
  pattern: RegExp;
}

// Specific occupations come before broad terms so that, for example, 営業事務 is not classified as 営業.
const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  rule("childcare_education", "academic_affairs_school_operations", /教務(?:事務|担当)?|学校運営|学校法人職員|大学事務|学校事務|academic affairs|school operations/i),
  rule("childcare_education", "student_support_career", /学生支援|就職支援|キャリア支援|student affairs|career services/i),
  rule("childcare_education", "childcare_kindergarten", /保育士|幼稚園教諭|保育教諭|childcare|kindergarten/i),
  rule("childcare_education", "teacher_lecturer_instructor", /教師|教員|講師|インストラクター|trainer|teacher|lecturer/i),
  rule("corporate_management", "human_resources_recruiting", /人事|労務|採用(?:担当|広報|責任者|マネージャー|マネジャー|リーダー|コーディネーター|業務)|中途採用|recruiter|talent acquisition|human resources|people operations|\bHRBP\b|\bHR (?:manager|specialist|operations)/i),
  rule("corporate_management", "accounting_finance", /経理|財務|会計|accounting|accountant|finance controller|bookkeep|treasurer/i),
  rule("corporate_management", "legal_compliance", /企業法務|法務(?:担当|ジェネラリスト|スペシャリスト|マネージャー)?|コンプライアンス|IT統制|知的財産|知財|in-house legal|compliance/i),
  rule("corporate_management", "general_affairs", /総務|庶務管理|general affairs/i),
  rule("corporate_management", "procurement_supply_chain", /購買|調達|サプライチェーン|\bSCM\b|procurement|sourcing/i),
  rule("corporate_management", "internal_audit_ir", /内部監査|内部統制|\bIR\b|investor relations|internal audit/i),
  rule("office_administration", "trade_international_office", /貿易事務|海外事務|国際事務|輸出入事務|trade operations|import.?export/i),
  rule("office_administration", "medical_office", /医療事務|調剤.*事務|介護事務|medical (?:office|clerk)/i),
  rule("office_administration", "sales_office_assistant", /営業事務|営業アシスタント|sales (?:assistant|administrator|coordinator)/i),
  rule("office_administration", "reception_secretary", /受付|秘書|receptionist|secretary|executive assistant/i),
  rule("office_administration", "data_entry_operations", /データ入力|事務オペレーター|入力オペレーター|data entry/i),
  rule("office_administration", "general_office_administration", /一般事務|事務職|事務スタッフ|事務員|オフィスワーク|administrative assistant|office administrator|office clerk|back.?office assistant/i),
  rule("professional_consulting_finance_real_estate", "interpreter_translator", /通訳|翻訳|ローカライズ|interpreter|translator|localization specialist/i),
  rule("sales_customer_success", "technical_sales", /技術営業|システム営業|セールスエンジニア|プリセールス|solutions? engineer|pre.?sales/i),
  rule("sales_customer_success", "customer_success_support", /カスタマーサクセス|カスタマーサポート|カスタマーサービス|customer success|customer support|client success/i),
  rule("sales_customer_success", "recruitment_consultant", /人材コーディネーター|キャリアアドバイザー|キャリアカウンセラー|recruitment consultant/i),
  rule("sales_customer_success", "inside_sales", /インサイドセールス|内勤営業|inside sales/i),
  rule("sales_customer_success", "account_management", /アカウントマネージャー|既存営業|ルートセールス|account manager|account executive/i),
  rule("sales_customer_success", "personal_sales", /個人営業|リテール営業|住宅営業|personal sales|retail sales consultant/i),
  rule("sales_customer_success", "corporate_sales", /法人営業|企画営業|海外営業|ソリューション営業|business development|corporate sales|enterprise sales/i),
  rule("sales_customer_success", "sales_management", /営業企画|営業推進|営業管理|sales operations|sales manager/i),
  rule("creative_design_media", "game_creative", /ゲームプランナー|ゲームデザイナー|レベルデザイナー|game planner|game designer|technical artist/i),
  rule("creative_design_media", "ui_ux_web_designer", /UI.?UX|Webデザイナー|ウェブデザイナー|product designer|interaction designer/i),
  rule("creative_design_media", "graphic_cg_designer", /グラフィックデザイナー|CGデザイナー|イラストレーター|graphic designer|3D artist|2D artist/i),
  rule("creative_design_media", "content_editor_writer", /編集|校正|ライター|コピーライター|コンテンツ制作|editor|writer|copywriter|content creator/i),
  rule("creative_design_media", "video_audio_production", /映像制作|動画制作|音響|撮影|フォトグラファー|video producer|videographer|sound designer/i),
  rule("creative_design_media", "industrial_spatial_design", /プロダクトデザイナー|工業デザイン|空間デザイン|インテリアデザイナー|industrial designer|spatial designer/i),
  rule("it_web_software", "game_engineer", /ゲーム.*(?:エンジニア|プログラマ)|(?:game|Unity|Unreal).*(?:engineer|developer|programmer)|クライアントエンジニア/i),
  rule("it_web_software", "mobile_app_engineer", /iOS|Android|Swift|Kotlin|Flutter|React Native|モバイルアプリ|スマホアプリ|mobile (?:app )?(?:engineer|developer)/i),
  rule("it_web_software", "data_ai_ml_engineer", /AIエンジニア|機械学習|データサイエンティスト|データエンジニア|ML engineer|machine learning|data scientist|data (?:platform |infrastructure |analytics )?engineer|computer vision|NLP engineer/i),
  rule("it_web_software", "frontend_engineer", /フロントエンド|frontend|front-end/i),
  rule("it_web_software", "backend_engineer", /バックエンド|backend|back-end|server-side engineer/i),
  rule("it_web_software", "fullstack_engineer", /フルスタック|full.?stack/i),
  rule("it_web_software", "infrastructure_cloud_sre", /インフラ(?:ストラクチャ)?エンジニア|クラウドインフラ|クラウドエンジニア|\bSRE\b|DevOps|platform engineer|cloud (?:infrastructure )?engineer/i),
  rule("it_web_software", "network_telecom_engineer", /ネットワークエンジニア|通信エンジニア|network engineer|telecom engineer/i),
  rule("it_web_software", "security_engineer", /セキュリティエンジニア|SOC analyst|security engineer|cyber.?security/i),
  rule("it_web_software", "qa_test_engineer", /QAエンジニア|テストエンジニア|品質保証.*ソフト|\bQA(?: engineer| lead| manager)?\b|quality assurance engineer|test engineer/i),
  rule("it_web_software", "internal_it_support", /社内SE|情報システム|情シス|ITサポート|ヘルプデスク|corporate IT|IT support|help.?desk/i),
  rule("it_web_software", "embedded_control_engineer", /組み込み|組込み|制御系|ファームウェア|embedded|firmware/i),
  rule("it_web_software", "pm_pdm_it_consulting", /プロダクトマネージャ[ー―]|プロジェクトマネージャ[ー―]|プロジェクトリーダー|ITコンサル|システムコンサル|\bPdM\b|\bPjM\b|\bPMO\b|project lead|program manager|delivery manager|technical program manager|IT consultant/i),
  rule("it_web_software", "general_software_engineer", /システムエンジニア|ソフトウェアエンジニア|ITエンジニア|Webエンジニア|開発エンジニア|プログラマ|software engineer|software developer|web developer/i),
  rule("planning_marketing_management", "marketing_growth", /マーケティング|広告運用|販促|グロース|SEO|SEM|organic search|marketing|growth/i),
  rule("planning_marketing_management", "product_service_planning", /商品企画|サービス企画|プロダクト企画|事業開発|product planning|service planning/i),
  rule("planning_marketing_management", "business_planning_strategy", /経営企画|事業企画|戦略企画|business planning|corporate strategy/i),
  rule("planning_marketing_management", "pr_communications", /広報|PR担当|\bPR manager|head of communications|communications manager|public relations/i),
  rule("planning_marketing_management", "executive_management", /代表取締役|執行役員|事業責任者|ゼネラルマネージャー|chief .* officer|country manager|general manager/i),
  rule("professional_consulting_finance_real_estate", "management_consultant", /経営コンサル|戦略コンサル|業務コンサル|コンサルタント|management consultant|strategy consultant|consulting/i),
  rule("professional_consulting_finance_real_estate", "licensed_legal_accounting_professional", /弁護士|弁理士|司法書士|行政書士|公認会計士|税理士|社会保険労務士|attorney|lawyer|CPA/i),
  rule("professional_consulting_finance_real_estate", "finance_investment_insurance", /銀行|証券|保険|投資|融資|アクチュアリー|トレーダー|ファンドマネージャー|investment|underwriter|actuary/i),
  rule("professional_consulting_finance_real_estate", "real_estate_professional", /不動産|用地仕入|プロパティマネージャー|real estate|property manager/i),
  rule("medical_healthcare", "nurse_midwife_public_health", /看護師|准看護師|保健師|助産師|nurse|midwife/i),
  rule("medical_healthcare", "doctor_dentist_veterinarian", /医師|歯科医師|獣医師|doctor|dentist|veterinarian/i),
  rule("medical_healthcare", "pharmacist", /薬剤師|pharmacist/i),
  rule("medical_healthcare", "medical_technologist_therapist", /理学療法士|作業療法士|言語聴覚士|臨床検査技師|診療放射線技師|therapist|medical technologist/i),
  rule("medical_healthcare", "clinical_research_regulatory", /臨床開発|治験|薬事|clinical research|clinical development|regulatory affairs/i),
  rule("welfare_care", "care_management", /ケアマネ|施設長|介護.*管理|care manager/i),
  rule("welfare_care", "social_worker_support", /社会福祉士|生活相談員|生活支援員|ソーシャルワーカー|social worker/i),
  rule("welfare_care", "care_worker", /介護職|介護福祉士|ヘルパー|care worker|caregiver/i),
  rule("architecture_construction_facilities", "construction_management", /施工管理|工事監理|construction manager|site manager/i),
  rule("architecture_construction_facilities", "architecture_design", /建築設計|意匠設計|構造設計|architect/i),
  rule("architecture_construction_facilities", "civil_engineering", /土木設計|橋梁設計|測量|積算|地質調査|civil engineer|surveyor/i),
  rule("architecture_construction_facilities", "facilities_plant_engineering", /設備設計|プラントエンジニア|電気工事|管工事|facility engineer|plant engineer/i),
  rule("engineering_research", "electrical_electronics_semiconductor", /電気設計|電子回路|半導体|回路設計|electrical engineer|electronics engineer|semiconductor/i),
  rule("engineering_research", "mechanical_engineering", /機械設計|機構設計|メカトロ|mechanical engineer/i),
  rule("engineering_research", "chemical_materials_engineering", /化学研究|素材開発|材料開発|chemical engineer|materials engineer/i),
  rule("engineering_research", "food_biotech_engineering", /食品開発|バイオ研究|生物研究|food scientist|biotech/i),
  rule("engineering_research", "quality_production_engineering", /生産技術|品質管理|品質保証|プロセスエンジニア|process engineer|production engineer|quality control/i),
  rule("engineering_research", "research_development", /研究員|研究開発|基礎研究|応用研究|R&D|researcher/i),
  rule("retail_service_hospitality", "hotel_travel_leisure", /ホテル|旅館|旅行|観光|添乗員|hotel|travel|tourism/i),
  rule("retail_service_hospitality", "food_service", /調理師|調理スタッフ|ホールスタッフ|飲食店|シェフ|cook|chef|restaurant staff/i),
  rule("retail_service_hospitality", "beauty_wellness", /美容師|エステティシャン|ネイリスト|セラピスト|beautician|esthetician/i),
  rule("retail_service_hospitality", "retail_store_operations", /販売スタッフ|店舗スタッフ|店長|小売|retail|store manager/i),
  rule("retail_service_hospitality", "general_customer_service", /接客|サービススタッフ|customer service associate/i),
  rule("logistics_transport_warehouse", "driver_delivery", /ドライバー|運転手|配送|配達|delivery driver|delivery associate|courier|\bdriver\b/i),
  rule("logistics_transport_warehouse", "transport_operations", /鉄道|航空|空港|乗務員|運行管理|railway|airline|transport operations/i),
  rule("logistics_transport_warehouse", "logistics_warehouse", /物流|倉庫|在庫管理|ロジスティクス|warehouse|logistics/i),
  rule("manufacturing_maintenance_skilled", "maintenance_mechanic", /整備士|メカニック|設備保全|修理|mechanic|maintenance technician/i),
  rule("manufacturing_maintenance_skilled", "skilled_construction_worker", /技能工|工事スタッフ|電気工|溶接|配管工|construction worker|welder/i),
  rule("manufacturing_maintenance_skilled", "manufacturing_operator", /製造(?:スタッフ|オペレーター|技術職|管理職)?|生産管理|機械オペレーター|工場(?:スタッフ|内軽作業)|組立|加工|manufacturing operator|factory worker/i),
  rule("public_organizations", "government_public_service", /国家公務員|地方公務員|市役所|区役所|官公庁|public servant|government officer/i),
  rule("public_organizations", "association_nonprofit_staff", /団体職員|NPO職員|NGO職員|公益法人職員|association staff|nonprofit/i),
  rule("security_cleaning_agriculture", "security_safety", /警備員|警察官|消防士|自衛官|security guard|police officer|firefighter/i),
  rule("security_cleaning_agriculture", "cleaning_facility_service", /清掃|美化|ビルクリーニング|cleaner|janitor/i),
  rule("security_cleaning_agriculture", "agriculture_forestry_fisheries", /農業|林業|漁業|水産|畜産|farmer|forestry|fisher/i),
  rule("sales_customer_success", "general_sales", /(?:^|[【】／/_\s-])営業(?:$|[【】／/_\s-])|営業職|営業担当|営業スタッフ|ルート営業|官庁営業|OEM営業|セールス|\bsales\b/i),
];

const SPECIALTY_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["iOS", /\biOS\b|\bSwift(?:UI)?\b/i],
  ["Android", /\bAndroid\b|\bKotlin\b/i],
  ["Unity", /\bUnity\b/i],
  ["Unreal Engine", /\bUnreal(?: Engine)?\b/i],
  ["AI・機械学習", /\bAI\b|機械学習|machine learning|\bLLM\b/i],
  ["Web", /\bWeb\b|フロントエンド|バックエンド|full.?stack/i],
  ["中国語", /中国語|Mandarin|Chinese/i],
  ["英語", /英語|English|TOEIC/i],
];

export function classifyOccupation(input: { title: string; descriptionText?: string }): OccupationClassification {
  const titleMatches = CLASSIFICATION_RULES.filter((candidate) => candidate.pattern.test(input.title));
  const descriptionText = input.descriptionText;
  const descriptionCandidates = titleMatches.length === 0 && descriptionText !== undefined && isGenericOccupationTitle(input.title)
    ? CLASSIFICATION_RULES.filter((candidate) => candidate.pattern.test(descriptionText.slice(0, 600)))
    : [];
  const descriptionFamilies = new Set(descriptionCandidates.map((candidate) => candidate.family));
  const descriptionMatches = descriptionFamilies.size === 1 ? descriptionCandidates : [];
  const matches = titleMatches.length > 0 ? titleMatches : descriptionMatches;
  const primaryRule = matches[0] ?? rule("other", "other_unclassified", /$^/);
  const primary = selection(primaryRule);
  const seenFamilies = new Set<OccupationFamilyId>([primary.family]);
  const secondary: OccupationSelection[] = [];
  for (const candidate of matches.slice(1)) {
    if (seenFamilies.has(candidate.family)) continue;
    secondary.push(selection(candidate));
    seenFamilies.add(candidate.family);
    if (secondary.length === 2) break;
  }
  const sourceText = `${input.title}\n${input.descriptionText ?? ""}`;
  const specialtyTags = SPECIALTY_RULES.filter(([, pattern]) => pattern.test(sourceText)).map(([label]) => label);
  return {
    taxonomyVersion: OCCUPATION_TAXONOMY_VERSION,
    primary,
    secondary,
    specialtyTags,
    confidence: titleMatches.length > 0 ? "high" : descriptionMatches.length > 0 ? "medium" : "low",
  };
}

export function occupationFamilyFacets(classifications: readonly OccupationClassification[]) {
  const counts = new Map<OccupationFamilyId, number>();
  for (const classification of classifications) {
    const families = new Set([classification.primary.family, ...classification.secondary.map((value) => value.family)]);
    for (const family of families) counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return OCCUPATION_TAXONOMY.map((family) => ({ id: family.id, label: family.label, count: counts.get(family.id) ?? 0 }));
}

export function rolePriorityWeight(classification: OccupationClassification, priorities: ReadonlyMap<string, number>): number {
  const selections = [classification.primary, ...classification.secondary];
  let best = 0;
  for (const selected of selections) {
    best = Math.max(best, priorities.get(selected.family) ?? 0, priorities.get(selected.role) ?? 0);
  }
  const aliases: ReadonlyArray<readonly [string, boolean]> = [
    ["product_web_ai_engineering", classification.primary.family === "it_web_software"],
    ["ios_engineering", classification.primary.role === "mobile_app_engineer" && classification.specialtyTags.includes("iOS")],
    ["unity_game_engineering", classification.primary.role === "game_engineer" && classification.specialtyTags.includes("Unity")],
    ["office_administration", classification.primary.family === "office_administration"],
    ["education_administration", classification.primary.role === "academic_affairs_school_operations"],
    ["human_resources_recruiting", classification.primary.role === "human_resources_recruiting"],
    ["bilingual_coordination", classification.primary.role === "trade_international_office"
      || classification.primary.role === "interpreter_translator"],
  ];
  for (const [alias, matches] of aliases) if (matches) best = Math.max(best, priorities.get(alias) ?? 0);
  return best;
}

function rule(family: OccupationFamilyId, roleId: OccupationRoleId, pattern: RegExp): ClassificationRule {
  return { family, role: roleId, pattern };
}

function selection(candidate: ClassificationRule): OccupationSelection {
  const family = OCCUPATION_TAXONOMY.find((value) => value.id === candidate.family);
  const selectedRole = family?.roles.find((value) => value.id === candidate.role);
  if (family === undefined || selectedRole === undefined) throw new Error(`Unknown occupation mapping: ${candidate.family}/${candidate.role}`);
  return { family: family.id, familyLabel: family.label, role: selectedRole.id, roleLabel: selectedRole.label };
}

function isGenericOccupationTitle(title: string): boolean {
  return /総合職|オープンポジション|職種未定|ポジション相談|general position/i.test(title);
}
