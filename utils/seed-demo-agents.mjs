/** 本地展示示例：仅新增固定 ID 的记录，不覆盖现有数据。运行：node utils/seed-demo-agents.mjs */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const origin = 'http://127.0.0.1:2001';
const imageDir = resolve('project/frontend/images/demo');
const examples = [
  {
    id: 'course-qa', name: '课程知识问答助手', title: '课程问答', label: 'COURSE KNOWLEDGE', color: '#47e9d2',
    discipline: '工学', major: '计算机科学与技术', course: '数据结构与算法', school: '示例大学', tags: '课程答疑,知识理解,引用说明',
    summary: '围绕课程概念、算法步骤与常见误区，展示知识问答类智能体的案例信息。',
    pain: '课后问题集中、基础概念容易混淆，学生需要能结合课程语境组织答案的学习入口。',
    guide: '示例流程：输入学习问题 → 查看分步解释 → 对照课程资料复核。\n可尝试的问题：栈和队列有什么区别？\n此记录仅演示页面，不提供真实问答服务。',
    audience: '课程学习者', scene: '课前预习 / 课后答疑',
    art: '<rect x="730" y="125" width="280" height="182" rx="22"/><path d="M778 307v45l63-45M777 176h152M777 209h183M777 242h115"/><rect x="860" y="327" width="208" height="95" rx="18"/><path d="M902 370h121M902 395h78"/>'
  },
  {
    id: 'assignment-feedback', name: '作业反馈辅助助手', title: '作业反馈', label: 'ASSIGNMENT FEEDBACK', color: '#ffbd78',
    discipline: '教育学', major: '教育技术学', course: '教学评价方法', school: '示例师范学院', tags: '作业反馈,评价量规,教师辅助',
    summary: '用评价维度、问题定位与修改建议，展示面向教师和学生的作业反馈案例。',
    pain: '作业反馈容易只留下分数，学生难以判断需要改进的具体步骤，教师重复说明耗时。',
    guide: '示例流程：选择评价维度 → 对照作答内容 → 查看问题与修改建议。\n评价建议应由教师复核；本页面未接入真实批改或成绩系统。',
    audience: '任课教师与学生', scene: '作业讲评 / 修改练习',
    art: '<rect x="761" y="113" width="238" height="296" rx="24"/><rect x="818" y="93" width="124" height="42" rx="12"/><path d="m799 187 12 13 26-32m-38 88 12 13 26-32m-38 88 12 13 26-32M863 187h97M863 256h97M863 325h65"/><circle cx="1029" cy="377" r="45"/><path d="m1009 377 14 14 27-28"/>'
  },
  {
    id: 'learning-path', name: '个性化学习路径助手', title: '学习规划', label: 'LEARNING PATHWAYS', color: '#86c7ff',
    discipline: '工学', major: '软件工程', course: '专业导论', school: '示例理工学院', tags: '学习规划,阶段目标,资源选择',
    summary: '以目标、前置知识与阶段任务为线索，展示学习路径类案例的完整字段。',
    pain: '面对大量课程与资源，学生不清楚先学什么、如何衔接，也难以将长期目标拆成可执行任务。',
    guide: '示例流程：填写学习目标 → 描述现有基础 → 查看阶段任务。\n示例主题：从基础编程到一个小型网站。\n展示内容为虚构样例，未生成真实学习计划。',
    audience: '专业入门学习者', scene: '课程衔接 / 自主学习',
    art: '<path d="M716 369h81V266h95V166h108"/><circle cx="716" cy="369" r="25"/><circle cx="797" cy="266" r="25"/><circle cx="892" cy="166" r="25"/><circle cx="1026" cy="166" r="35"/><path d="m1011 166 11 11 22-24M693 426h91M793 325h92M897 111h83"/>'
  },
  {
    id: 'lab-guide', name: '实验预习与操作指导助手', title: '实验指导', label: 'LAB PREPARATION', color: '#80e7b6',
    discipline: '理学', major: '应用化学', course: '基础化学实验', school: '示例理工学院', tags: '实验预习,步骤核对,安全提醒',
    summary: '展示实验目标、操作流程与复核要点，让实验指导类案例有清晰的内容层级。',
    pain: '学生预习时容易忽略操作顺序、记录要求与实验室安全规范，需要在进入实验室前整理要点。',
    guide: '示例流程：选择实验主题 → 阅读预习清单 → 由教师确认操作要求。\n实际实验必须以课程手册、实验室规范与现场指导为准。\n此记录仅用于界面展示。',
    audience: '实验课程学生', scene: '课前预习 / 实验复盘',
    art: '<path d="M829 108h100m-83 0v113l-88 148q-18 39 30 39h186q47 0 28-39l-90-148V108M788 319h183"/><circle cx="839" cy="365" r="9"/><circle cx="913" cy="352" r="14"/><circle cx="967" cy="156" r="21"/><circle cx="1009" cy="238" r="10"/><path d="M711 193h61m-30-30v60"/>'
  },
  {
    id: 'language-practice', name: '英语表达练习伙伴', title: '语言练习', label: 'LANGUAGE PRACTICE', color: '#ffd678',
    discipline: '文学', major: '英语', course: '大学英语口语', school: '示例大学', tags: '场景对话,表达练习,语言学习',
    summary: '以场景、表达目标和练习建议展示语言学习类案例，兼顾简短介绍与较长使用说明。',
    pain: '课堂之外缺少稳定的表达练习场景，学生希望先整理思路，再对照例句调整表达。',
    guide: '示例流程：选择交流情境 → 阅读表达目标 → 自行完成对话练习。\n练习主题示例：校园问路、课程介绍、小组讨论。\n本记录未接入语音识别或实时对话。',
    audience: '大学英语学习者', scene: '情境练习 / 口语准备',
    art: '<rect x="722" y="129" width="215" height="146" rx="26"/><path d="m756 275 1 42 55-42"/><rect x="870" y="283" width="217" height="135" rx="26"/><path d="m1026 418-1 36-49-36M765 201v-22m28 48v-74m28 92v-110m28 92v-74m28 48v-22M911 337h129M911 372h89"/>'
  },
  {
    id: 'concept-review', name: '基础医学概念复习助手', title: '概念复习', label: 'CONCEPT REVIEW', color: '#ff9292',
    discipline: '医学', major: '基础医学', course: '人体解剖学', school: '示例医学院', tags: '概念复习,课程学习,教师复核',
    summary: '展示课程概念整理、复习提纲和教学复核提示，作为医学课程界面的示例内容。',
    pain: '概念数量多、章节关系复杂，学生需要按照课程目录归纳知识点并由教师校核。',
    guide: '示例流程：选择章节 → 整理概念列表 → 对照教材和教师讲解复习。\n本案例只展示页面布局，未提供医学问答、诊断或治疗建议。',
    audience: '医学基础课程学习者', scene: '章节复习 / 概念梳理',
    art: '<path d="M881 172q-90-49-158-13v216q81-32 158 6 76-38 157-6V159q-68-36-157 13v209M760 214h79m-79 42h79m-79 42h79M922 214h79m-79 42h79m-79 42h79"/><circle cx="881" cy="118" r="31"/><path d="M865 118h32m-16-16v32"/>'
  },
  {
    id: 'research-reading', name: '文献阅读整理助手', title: '文献阅读', label: 'RESEARCH READING', color: '#66d7ee',
    discipline: '管理学', major: '信息管理与信息系统', course: '学术研究方法', school: '示例研究学院', tags: '文献阅读,笔记整理,来源核对',
    summary: '展示研究问题、阅读笔记与来源复核，帮助对比资料整理类案例的卡片效果。',
    pain: '阅读笔记分散，研究问题、方法和结论难以对应，需要一套清晰的整理顺序。',
    guide: '示例流程：记录文献信息 → 摘录研究问题与方法 → 回原文核对。\n引用和总结必须由阅读者自行校验。\n当前为展示示例，不含真实论文或检索结果。',
    audience: '课程研究与论文写作学习者', scene: '阅读笔记 / 资料整理',
    art: '<rect x="737" y="134" width="163" height="228" rx="15"/><path d="M773 185h91M773 224h91M773 263h61"/><rect x="824" y="169" width="166" height="228" rx="15"/><path d="M864 213h85M864 247h55"/><circle cx="1008" cy="326" r="59"/><path d="m1050 369 54 54"/>'
  },
  {
    id: 'career-practice', name: '职业情境练习助手', title: '情境练习', label: 'CAREER SCENARIOS', color: '#b8df82',
    discipline: '经济学', major: '国际经济与贸易', course: '商务沟通', school: '示例应用学院', tags: '场景练习,沟通表达,课程案例',
    summary: '用任务背景、沟通目标和练习步骤展示情境训练类案例；同时演示未启用状态。',
    pain: '学生了解理论知识，但在描述任务、组织沟通与复盘表达时缺少连续的练习素材。',
    guide: '示例流程：阅读任务背景 → 明确沟通目标 → 完成表达练习并由教师反馈。\n该示例设为未启用，仅用于查看状态标签和筛选效果。',
    audience: '商务沟通课程学生', scene: '课堂情境 / 表达复盘', status: 'inactive',
    art: '<rect x="748" y="196" width="270" height="185" rx="24"/><path d="M830 196v-43h103v43M748 259q134 71 270 0"/><rect x="867" y="277" width="33" height="30" rx="6"/><circle cx="1034" cy="147" r="43"/><path d="m1018 147 11 12 24-25"/>'
  }
];

mkdirSync(imageDir, { recursive: true });
const db = new DatabaseSync(resolve('database/agent-website.db'));
db.exec('PRAGMA busy_timeout = 4000;');
const insert = db.prepare(`INSERT INTO agents (
  id, name, summary, tags, status, data_json, discipline, major, course_name,
  agent_url, school_name, cover_image, pain_point, usage_guide, created_by, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
ON CONFLICT(id) DO NOTHING`);
const timestamp = Date.now();
let added = 0;
try {
  db.exec('BEGIN');
  for (const [index, item] of examples.entries()) {
    const file = resolve(imageDir, `${item.id}.svg`);
    if (!existsSync(file)) writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="525" viewBox="0 0 1200 525">
<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#0b1823"/><stop offset="1" stop-color="#060b12"/></linearGradient><radialGradient id="glow"><stop stop-color="${item.color}" stop-opacity=".18"/><stop offset="1" stop-color="${item.color}" stop-opacity="0"/></radialGradient><pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0v48" fill="none" stroke="#fff" stroke-opacity=".035"/></pattern></defs>
<rect width="1200" height="525" fill="url(#bg)"/><rect width="1200" height="525" fill="url(#grid)"/><ellipse cx="900" cy="260" rx="360" ry="310" fill="url(#glow)"/><circle cx="883" cy="262" r="218" fill="none" stroke="${item.color}" stroke-opacity=".1"/><circle cx="883" cy="262" r="185" fill="none" stroke="${item.color}" stroke-opacity=".08"/>
<g font-family="Segoe UI,Microsoft YaHei,sans-serif"><rect x="56" y="61" width="48" height="5" rx="2" fill="${item.color}"/><text x="120" y="69" fill="${item.color}" font-size="17" letter-spacing="3">DEMO CASE / ${String(index + 1).padStart(2, '0')}</text><text x="54" y="235" fill="#f4f8fa" font-size="58" font-weight="600">${item.title}</text><text x="58" y="283" fill="${item.color}" font-size="18" letter-spacing="3">${item.label}</text><text x="58" y="432" fill="#8697a6" font-size="18">页面展示示例 · 非真实服务</text></g>
<g fill="${item.color}" fill-opacity=".035" stroke="${item.color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${item.art}</g></svg>`, 'utf8');
    const time = timestamp - index * 1000;
    added += insert.run(`demo_seed_${item.id}`, `${item.name}（示例）`, item.summary, `示例数据,${item.tags}`,
      item.status || 'active', JSON.stringify({ 数据性质: '虚构页面展示示例，非真实教学成果', 适用对象: item.audience, 应用场景: item.scene, 链接说明: '返回本地案例库，仅演示新标签跳转；未接入真实智能体' }),
      item.discipline, item.major, item.course, `${origin}/agents.html?demo=${item.id}`, item.school,
      `${origin}/images/demo/${item.id}.svg`, item.pain, `${item.guide}\n链接仅返回本地案例库，用于演示新标签跳转。`, time, time).changes;
  }
  db.exec('COMMIT');
  console.log(JSON.stringify({ added, demoTotal: examples.length, page: `${origin}/agents.html` }));
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
