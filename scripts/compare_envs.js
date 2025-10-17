const fs = require('fs').promises;
const path = require('path');
const simpleGit = require('simple-git');
const propertiesParser = require('properties-parser');

// รับพารามิเตอร์ tag และ filter จาก command line
const [, , tag, filter = 'true'] = process.argv;
if (!tag) {
  console.error('การใช้งาน: node compare_envs.js <tag> [filter]');
  process.exit(1);
}

// กำหนด path ไปยัง cloud-config repo
const repoPath = process.env.CLOUD_CONFIG_PATH || path.resolve(__dirname, '../../cloud-config');

// ตรวจสอบว่า repoPath มีอยู่และเป็น Git repository
async function checkRepoPath() {
  try {
    await fs.access(repoPath);
    await fs.access(path.join(repoPath, '.git'));
    console.error(`Repo path ถูกต้อง: ${repoPath}`);
  } catch (err) {
    console.error(`ข้อผิดพลาด: Directory ${repoPath} ไม่มีอยู่หรือไม่ใช่ Git repository`);
    process.exit(1);
  }
}

const git = simpleGit(repoPath);

// ฟังก์ชันช่วยดึงเนื้อหาไฟล์จาก tag ที่ระบุ
async function getFileContent(tag, filePath) {
  try {
    const content = await git.show(`${tag}:${filePath}`);
    return propertiesParser.parse(content);
  } catch (err) {
    if (err.message.includes('exists on disk, but not in')) return null;
    throw new Error(`ไม่สามารถดึงไฟล์ ${filePath} จาก tag ${tag}: ${err.message}`);
  }
}

// ฟังก์ชันลบ prefix ออกจาก value
function normalizeValue(value, isPt = true) {
  if (!value) return '';
  // ลบ pt-, prod-, prd- ออกจากทุกส่วนของ value
  const patterns = isPt
    ? [/pt-/g, /contents-pt/g]
    : [/prod-/g, /prd-/g, /contents/g];
  let normalized = value;
  patterns.forEach(pattern => {
    normalized = normalized.replace(pattern, '');
  });
  return normalized;
}

// ฟังก์ชันคำนวณ diff ระหว่างออบเจ็กต์ pt และ prod
function computeDiffs(ptObj, prodObj, applyFilter = true) {
  const diffs = [];
  const allKeys = new Set([...Object.keys(ptObj || {}), ...Object.keys(prodObj || {})]);

  // Debug: เก็บคีย์ที่ถูกกรอง
  const ignoredKeys = [];

  allKeys.forEach(key => {
    const ptVal = ptObj ? ptObj[key] : undefined;
    const prodVal = prodObj ? prodObj[key] : undefined;

    if (ptVal !== prodVal) {
      let shouldIgnore = false;
      if (applyFilter) {
        // เปรียบเทียบ value โดยลบ prefix
        const normalizedPtVal = normalizeValue(ptVal, true);
        const normalizedProdVal = normalizeValue(prodVal, false);
        if (normalizedPtVal && normalizedProdVal && normalizedPtVal === normalizedProdVal) {
          shouldIgnore = true;
          ignoredKeys.push(`${key} (pt: ${ptVal}, prod: ${prodVal}, normalized: ${normalizedPtVal})`);
        }
      }

      if (!shouldIgnore) {
        diffs.push({
          key,
          pt: ptVal,
          prod: prodVal,
          type: ptVal === undefined ? 'added_in_prod' : prodVal === undefined ? 'added_in_pt' : 'changed'
        });
      } else {
        console.error(`ข้าม diff: ${key} (pt: ${ptVal}, prod: ${prodVal})`);
      }
    }
  });

  // Debug: แสดงคีย์ที่ถูกกรอง
  if (applyFilter && ignoredKeys.length > 0) {
    console.error(`คีย์ที่ถูกกรอง: ${ignoredKeys.join(', ')}`);
  } else if (applyFilter) {
    console.error('ไม่มีคีย์ที่ถูกกรอง');
  }

  return diffs;
}

// ฟังก์ชันลิสต์ไฟล์ในโฟลเดอร์จาก tag
async function listFiles(tag, dir) {
  try {
    const output = await git.raw(['ls-tree', '-r', '--name-only', tag, dir]);
    return output.split('\n').filter(f => f.trim() !== '');
  } catch (err) {
    throw new Error(`ไม่สามารถลิสต์ไฟล์จาก ${dir} ใน tag ${tag}: ${err.message}`);
  }
}

async function main() {
  await checkRepoPath();

  const result = { envs: { pt: {}, prod: {} }, diffs: {} };

  try {
    // ตรวจสอบว่า tag มีอยู่ใน repo
    const tags = await git.tags();
    const commits = await git.raw(['rev-list', '--all']);
    const validRefs = new Set([...tags.all, ...commits.split('\n')]);
    if (!validRefs.has(tag)) {
      throw new Error(`Tag หรือ commit ไม่ถูกต้อง: ${tag}`);
    }

    const configDir = 'config';
    const envs = ['pt', 'prod'];

    // วนลูปแต่ละ env
    for (const env of envs) {
      const envPath = `${configDir}/${env}`;
      const files = (await listFiles(tag, envPath))
        .filter(f => f.endsWith('.properties'));

      for (const fullPath of files) {
        const fileName = path.basename(fullPath);
        const content = await getFileContent(tag, fullPath);
        result.envs[env][fileName] = content;
      }
    }

    // เปรียบเทียบไฟล์ระหว่าง pt และ prod
    const allFiles = new Set([...Object.keys(result.envs.pt), ...Object.keys(result.envs.prod)]);
    allFiles.forEach(fileName => {
      const ptContent = result.envs.pt[fileName] || null;
      const prodContent = result.envs.prod[fileName] || null;
      const diffs = computeDiffs(ptContent, prodContent, filter === 'true');

      if (diffs.length > 0 || ptContent === null || prodContent === null) {
        result.diffs[fileName] = {
          pt: ptContent,
          prod: prodContent,
          diffs
        };
      }
    });

    // ลบ envs เพื่อลดขนาด JSON
    delete result.envs;

    // Debug: แสดงจำนวน diffs รวม
    console.error(`จำนวน diffs รวม: ${Object.values(result.diffs).reduce((sum, file) => sum + file.diffs.length, 0)}`);

    // ส่งออกผลลัพธ์เป็น JSON
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('ข้อผิดพลาด:', err.message);
    process.exit(1);
  }
}

main();