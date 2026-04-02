#!/usr/bin/env node
/**
 * 词库转换脚本
 * 按照改造方案：移除现代明星/品牌/影视/网络用语，替换为中国历史文化内容
 */

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'src', 'data', 'words.json');
const OUTPUT = path.join(__dirname, '..', 'src', 'data', 'words.json');

const data = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));

// ========== people: 保留指定ID，新增30组 ==========
const PEOPLE_KEEP_IDS = new Set([
  'people-090', 'people-091', 'people-092', 'people-093', 'people-094',
  'people-095', 'people-096', 'people-097', 'people-098', 'people-100',
  'people-101', 'people-102', 'people-103', 'people-104', 'people-105',
  'people-135', 'people-142', 'people-143', 'people-144', 'people-146',
  'people-147', 'people-148', 'people-151', 'people-152', 'people-153',
  'people-154', 'people-162',
]);

const PEOPLE_NEW = [
  { words: ['张衡', '祖冲之', '毕昇'] },
  { words: ['华佗', '扁鹊', '李时珍'] },
  { words: ['鲁班', '墨子', '马钧'] },
  { words: ['王羲之', '颜真卿', '柳公权'] },
  { words: ['顾恺之', '吴道子', '郑板桥'] },
  { words: ['伯牙', '嵇康', '蔡邕'] },
  { words: ['陆游', '陶渊明', '王维'] },
  { words: ['司马迁', '班固', '司马光'] },
  { words: ['庄子', '荀子', '韩非子'] },
  { words: ['大禹', '后羿', '夸父'] },
  { words: ['女娲', '嫦娥', '精卫'] },
  { words: ['神农', '伏羲', '燧人'] },
  { words: ['蒙恬', '卫青', '霍去病'] },
  { words: ['孙武', '孙膑', '吴起'] },
  { words: ['管仲', '商鞅', '张良'] },
  { words: ['太白金星', '土地公', '阎王'] },
  { words: ['钟馗', '关公', '妈祖'] },
  { words: ['铁拐李', '汉钟离', '吕洞宾'] },
  { words: ['孟姜女', '白娘子', '祝英台'] },
  { words: ['牛郎', '许仙', '梁山伯'] },
  { words: ['文成公主', '蔡文姬', '上官婉儿'] },
  { words: ['郑和', '张骞', '玄奘'] },
  { words: ['吕蒙', '陆逊', '甘宁'] },
  { words: ['贾岛', '孟郊', '韩愈'] },
  { words: ['纪晓岚', '刘墉', '和珅'] },
  { words: ['曹植', '曹丕', '杨修'] },
  { words: ['武则天', '孝庄', '慈禧'] },
  { words: ['郑成功', '林则徐', '邓世昌'] },
  { words: ['鬼谷子', '黄石公', '司马徽'] },
  { words: ['鲁迅', '老舍', '冰心'] },
];

// ========== idioms: 删除网络用语 ==========
const IDIOMS_REMOVE_IDS = new Set([
  'idioms-005', 'idioms-010', 'idioms-012', 'idioms-024', 'idioms-045',
  'idioms-053', 'idioms-059', 'idioms-062', 'idioms-074', 'idioms-075',
  'idioms-099', 'idioms-103', 'idioms-106', 'idioms-112', 'idioms-126',
  'idioms-143', 'idioms-149', 'idioms-158', 'idioms-163', 'idioms-164',
  'idioms-165', 'idioms-166',
]);

// ========== digital_internet: 删除品牌/游戏/AI ==========
const DIGITAL_REMOVE_IDS = new Set([
  'digital_internet-009', 'digital_internet-011', 'digital_internet-012',
  'digital_internet-028', 'digital_internet-036', 'digital_internet-046',
  'digital_internet-071', 'digital_internet-075', 'digital_internet-082',
]);

// ========== daily_items: 删除化妆品细分 ==========
const DAILY_REMOVE_IDS = new Set([
  'daily_items-031', 'daily_items-051', 'daily_items-071',
  'daily_items-079', 'daily_items-085', 'daily_items-098',
  'daily_items-122',
]);

// ========== city_travel: 删除网络用语 ==========
const CITY_REMOVE_IDS = new Set([
  'city_travel-025',
]);

// ========== tradition_nature: 全新分类（替换brands）==========
const TRADITION_NATURE_GROUPS = [
  { words: ['春节', '元宵', '端午'] },
  { words: ['中秋', '重阳', '腊八'] },
  { words: ['清明', '寒食', '中元'] },
  { words: ['春联', '年画', '灯笼'] },
  { words: ['鞭炮', '烟花', '孔明灯'] },
  { words: ['剪纸', '泥人', '皮影'] },
  { words: ['刺绣', '织锦', '蜡染'] },
  { words: ['陶瓷', '紫砂', '琉璃'] },
  { words: ['毛笔', '墨汁', '宣纸'] },
  { words: ['砚台', '镇纸', '笔架'] },
  { words: ['二胡', '古筝', '琵琶'] },
  { words: ['笛子', '箫', '唢呐'] },
  { words: ['象棋', '围棋', '跳棋'] },
  { words: ['龙舟', '风筝', '秋千'] },
  { words: ['蹴鞠', '投壶', '射箭'] },
  { words: ['太极', '咏春', '少林'] },
  { words: ['丝绸', '瓷器', '茶叶'] },
  { words: ['火药', '指南针', '造纸'] },
  { words: ['梅花', '兰花', '竹子'] },
  { words: ['菊花', '荷花', '桂花'] },
  { words: ['松树', '柏树', '杉树'] },
  { words: ['泰山', '华山', '嵩山'] },
  { words: ['黄山', '庐山', '峨眉山'] },
  { words: ['长江', '黄河', '珠江'] },
  { words: ['渤海', '黄海', '东海'] },
  { words: ['长城', '故宫', '天坛'] },
  { words: ['兵马俑', '莫高窟', '龙门石窟'] },
  { words: ['茶壶', '茶杯', '茶盘'] },
  { words: ['龙凤', '麒麟', '貔貅'] },
  { words: ['红包', '压岁钱', '福袋'] },
  { words: ['糖葫芦', '棉花糖', '麦芽糖'] },
  { words: ['旗袍', '汉服', '唐装'] },
  { words: ['秧歌', '腰鼓', '舞狮'] },
  { words: ['算盘', '铜钱', '元宝'] },
  { words: ['亭子', '牌坊', '宝塔'] },
  { words: ['石桥', '木桥', '吊桥'] },
  { words: ['拜年', '祭祖', '赏月'] },
  { words: ['麻将', '扑克', '骰子'] },
  { words: ['扇子', '油纸伞', '拨浪鼓'] },
  { words: ['青铜器', '玉器', '漆器'] },
  { words: ['京剧', '越剧', '黄梅戏'] },
  { words: ['花脸', '青衣', '小生'] },
  { words: ['编钟', '古琴', '瑟'] },
  { words: ['景泰蓝', '唐三彩', '青花瓷'] },
];

// ========== classical_stories: 全新分类（替换film_tv_variety）==========
const CLASSICAL_STORIES_GROUPS = [
  { words: ['西游记', '封神榜', '聊斋'] },
  { words: ['三国演义', '水浒传', '红楼梦'] },
  { words: ['牛郎织女', '白蛇传', '梁祝'] },
  { words: ['孟姜女', '精卫', '愚公'] },
  { words: ['嫦娥', '夸父', '后羿'] },
  { words: ['唐诗', '宋词', '元曲'] },
  { words: ['五言诗', '七言诗', '绝句'] },
  { words: ['西厢记', '牡丹亭', '长生殿'] },
  { words: ['岳飞传', '杨家将', '薛仁贵'] },
  { words: ['三字经', '百家姓', '千字文'] },
  { words: ['孙子兵法', '三十六计', '吴子兵法'] },
  { words: ['论语', '孟子', '大学'] },
  { words: ['诗经', '楚辞', '离骚'] },
  { words: ['盘古', '女娲', '伏羲'] },
  { words: ['空城计', '连环计', '苦肉计'] },
  { words: ['景阳冈', '野猪林', '快活林'] },
  { words: ['大观园', '潇湘馆', '怡红院'] },
  { words: ['火焰山', '流沙河', '五指山'] },
  { words: ['卧龙', '凤雏', '冢虎'] },
  { words: ['青龙', '白虎', '朱雀'] },
  { words: ['玄武', '饕餮', '穷奇'] },
  { words: ['金箍棒', '钉耙', '降妖杖'] },
  { words: ['偃月刀', '蛇矛', '画戟'] },
  { words: ['花果山', '水帘洞', '蟠桃园'] },
  { words: ['蟠桃', '人参果', '仙丹'] },
];

// ========== 执行转换 ==========

const newCategories = [];

for (const cat of data.categories) {
  if (cat.id === 'food') {
    // 美食：完整保留
    newCategories.push(cat);
    continue;
  }

  if (cat.id === 'people') {
    // 人物：保留指定ID + 新增
    const kept = cat.groups.filter(g => PEOPLE_KEEP_IDS.has(g.id));
    // 重新编号
    const allGroups = [...kept];
    let newIdx = 1;
    // 先给保留的重新编号
    const renumbered = allGroups.map((g, i) => ({
      id: `people-${String(i + 1).padStart(3, '0')}`,
      words: g.words,
    }));
    // 再追加新增的
    const newGroups = PEOPLE_NEW.map((g, i) => ({
      id: `people-${String(renumbered.length + i + 1).padStart(3, '0')}`,
      words: g.words,
    }));
    const finalGroups = [...renumbered, ...newGroups];
    newCategories.push({
      id: 'people',
      label: '人物',
      description: '',
      groups: finalGroups,
      groupCount: finalGroups.length,
    });
    console.log(`people: 保留 ${kept.length} 组，新增 ${PEOPLE_NEW.length} 组，共 ${finalGroups.length} 组`);
    continue;
  }

  if (cat.id === 'brands') {
    // 品牌 → 传统与自然
    const groups = TRADITION_NATURE_GROUPS.map((g, i) => ({
      id: `tradition_nature-${String(i + 1).padStart(3, '0')}`,
      words: g.words,
    }));
    newCategories.push({
      id: 'tradition_nature',
      label: '传统与自然',
      description: '传统节日、工艺、文化符号、自然地理',
      groups,
      groupCount: groups.length,
    });
    console.log(`tradition_nature: 新增 ${groups.length} 组`);
    continue;
  }

  if (cat.id === 'film_tv_variety') {
    // 影视综艺 → 古典文学与故事
    const groups = CLASSICAL_STORIES_GROUPS.map((g, i) => ({
      id: `classical_stories-${String(i + 1).padStart(3, '0')}`,
      words: g.words,
    }));
    newCategories.push({
      id: 'classical_stories',
      label: '古典文学与故事',
      description: '古典名著、民间传说、诗词歌赋',
      groups,
      groupCount: groups.length,
    });
    console.log(`classical_stories: 新增 ${groups.length} 组`);
    continue;
  }

  if (cat.id === 'idioms') {
    // 成语：删除网络用语
    const kept = cat.groups.filter(g => !IDIOMS_REMOVE_IDS.has(g.id));
    const renumbered = kept.map((g, i) => ({
      id: `idioms-${String(i + 1).padStart(3, '0')}`,
      words: g.words,
    }));
    newCategories.push({
      id: 'idioms',
      label: '成语表达',
      description: '',
      groups: renumbered,
      groupCount: renumbered.length,
    });
    console.log(`idioms: 删除 ${cat.groups.length - kept.length} 组，保留 ${kept.length} 组`);
    continue;
  }

  if (cat.id === 'digital_internet') {
    // 数码：删除品牌/游戏/AI
    const kept = cat.groups.filter(g => !DIGITAL_REMOVE_IDS.has(g.id));
    const renumbered = kept.map((g, i) => ({
      id: `digital_internet-${String(i + 1).padStart(3, '0')}`,
      words: g.words,
    }));
    newCategories.push({
      id: 'digital_internet',
      label: '数码互联网',
      description: '',
      groups: renumbered,
      groupCount: renumbered.length,
    });
    console.log(`digital_internet: 删除 ${cat.groups.length - kept.length} 组，保留 ${kept.length} 组`);
    continue;
  }

  if (cat.id === 'daily_items') {
    // 日常用品：删除化妆品细分
    const kept = cat.groups.filter(g => !DAILY_REMOVE_IDS.has(g.id));
    const renumbered = kept.map((g, i) => ({
      id: `daily_items-${String(i + 1).padStart(3, '0')}`,
      words: g.words,
    }));
    newCategories.push({
      id: 'daily_items',
      label: '日常用品',
      description: '',
      groups: renumbered,
      groupCount: renumbered.length,
    });
    console.log(`daily_items: 删除 ${cat.groups.length - kept.length} 组，保留 ${kept.length} 组`);
    continue;
  }

  if (cat.id === 'city_travel') {
    // 城市出行：删除1组网络用语
    const kept = cat.groups.filter(g => !CITY_REMOVE_IDS.has(g.id));
    const renumbered = kept.map((g, i) => ({
      id: `city_travel-${String(i + 1).padStart(3, '0')}`,
      words: g.words,
    }));
    newCategories.push({
      id: 'city_travel',
      label: '城市出行',
      description: '',
      groups: renumbered,
      groupCount: renumbered.length,
    });
    console.log(`city_travel: 删除 ${cat.groups.length - kept.length} 组，保留 ${kept.length} 组`);
    continue;
  }

  // 未知分类直接保留
  newCategories.push(cat);
}

// 计算总数
const totalGroups = newCategories.reduce((sum, c) => sum + c.groups.length, 0);

// 构建新文件
const newData = {
  meta: {
    version: 8,
    name: 'who_is_the_spy_classic_curated',
    description: '经典文化版词库。移除现代明星、品牌、网络用语，以中国历史文化、传统工艺、古典文学为主题，适合青少年玩家。',
    generatedAt: new Date().toISOString(),
    categoryCount: newCategories.length,
    groupCount: totalGroups,
    sourceVersion: 4,
  },
  categories: newCategories,
};

// 写入文件
fs.writeFileSync(OUTPUT, JSON.stringify(newData, null, 2) + '\n', 'utf-8');

console.log(`\n总计: ${totalGroups} 组词，${newCategories.length} 个分类`);
console.log(`已写入: ${OUTPUT}`);
