const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const propertiesParser = require('properties-parser');

// รับพารามิเตอร์ oldTag และ newTag จาก command line
const [, , oldTag, newTag] = process.argv;
if (!oldTag || !newTag) {
  console.error('การใช้งาน: node check_config.js <oldTag> <newTag>');
  process.exit(1);
}

// กำหนด path ไปยัง cloud-config repo
const repoPath = process.env.CLOUD_CONFIG_PATH || path.resolve(__dirname, '../../cloud-config');
const git = simpleGit(repoPath);

// ฟังก์ชันช่วยดึงเนื้อหาไฟล์จาก tag ที่ระบุ
async function getFileContent(tag, filePath) {
  try {
    // ลองดึงเนื้อหาไฟล์จาก tag ด้วย git show
    const content = await git.show(`${tag}:${filePath}`);
    // แปลงเนื้อหา .properties เป็นออบเจ็กต์
    return propertiesParser.parse(content);
  } catch (err) {
    // ถ้าไฟล์ไม่มีใน tag นั้น คืนค่า null
    if (err.message.includes('exists on disk, but not in')) return null;
    throw new Error(`ไม่สามารถดึงไฟล์ ${filePath} จาก tag ${tag}: ${err.message}`);
  }
}

// ฟังก์ชันคำนวณ diff ระหว่างออบเจ็กต์เก่าและใหม่
function computeDiffs(oldObj, newObj) {
  const diffs = [];
  // รวมคีย์ทั้งหมดจากทั้งสองออบเจ็กต์เพื่อตรวจสอบ
  const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);

  // วนลูปทุกคีย์เพื่อเปรียบเทียบค่า
  allKeys.forEach(key => {
    const oldVal = oldObj ? oldObj[key] : undefined;
    const newVal = newObj ? newObj[key] : undefined;
    // ถ้าค่าไม่เท่ากัน บันทึกการเปลี่ยนแปลง
    if (oldVal !== newVal) {
      diffs.push({
        key,
        old: oldVal,
        new: newVal,
        type: oldVal === undefined ? 'added' : newVal === undefined ? 'removed' : 'changed'
      });
    }
  });
  return diffs;
}

// ฟังก์ชันลิสต์ไฟล์หรือโฟลเดอร์ใน tag
async function listFiles(tag, dir = '.') {
  try {
    // รันคำสั่ง git ls-tree เพื่อลิสต์ไฟล์หรือโฟลเดอร์
    const output = await git.raw(['ls-tree', '-r', '--name-only', tag, dir]);
    // แยกผลลัพธ์เป็นอาร์เรย์และกรองเฉพาะที่ไม่ว่าง
    return output.split('\n').filter(f => f.trim() !== '');
  } catch (err) {
    // จัดการข้อผิดพลาดถ้า path ไม่ถูกต้อง
    if (err.message.includes('not a valid pathspec')) {
      throw new Error(`Path ไม่ถูกต้อง: ${dir} ใน tag ${tag}`);
    }
    throw new Error(`ไม่สามารถลิสต์ไฟล์จาก ${dir} ใน tag ${tag}: ${err.message}`);
  }
}

async function main() {
  const result = { envs: {} };

  try {
    // ตรวจสอบว่า tag ทั้งสองมีอยู่ใน repo
    const tags = await git.tags();
    const commits = await git.raw(['rev-list', '--all']);
    const validRefs = new Set([...tags.all, ...commits.split('\n')]);
    if (!validRefs.has(oldTag) || !validRefs.has(newTag)) {
      throw new Error(`Tag หรือ commit ไม่ถูกต้อง: oldTag=${oldTag}, newTag=${newTag}`);
    }

    // ลิสต์โฟลเดอร์ env จาก config/ ใน newTag
    const configDir = 'config';
    let allFiles = [];
    try {
      allFiles = await listFiles(newTag, configDir);
    } catch (err) {
      // ถ้า config/ ไม่มีใน tag ให้คืน env ว่าง
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const envs = [...new Set(
      allFiles
        .map(p => {
          const relative = path.relative(configDir, path.dirname(p));
          return relative.split(path.sep)[0];
        })
        .filter(p => p && p !== '.')
    )];

    // วนลูปแต่ละ env
    for (const env of envs) {
      result.envs[env] = {};
      const envPath = `${configDir}/${env}`;

      // ลิสต์ไฟล์ .properties ใน env จาก newTag
      const files = (await listFiles(newTag, envPath))
        .filter(f => f.endsWith('.properties'));

      // วนลูปแต่ละไฟล์
      for (const fullPath of files) {
        const fileName = path.basename(fullPath);
        // ดึงเนื้อหาเก่าและใหม่
        const oldContent = await getFileContent(oldTag, fullPath);
        const newContent = await getFileContent(newTag, fullPath);
        // คำนวณ diff
        const diffs = computeDiffs(oldContent, newContent);

        // เก็บเฉพาะไฟล์ที่มี change (diffs > 0 หรือถูกเพิ่ม/ลบ)
        if (diffs.length > 0 || oldContent === null || newContent === null) {
          result.envs[env][fileName] = {
            old: oldContent,
            new: newContent,
            diffs
          };
        }
      }
    }

    // ลบ env ที่ไม่มี service ที่เปลี่ยนแปลง
    for (const env in result.envs) {
      if (Object.keys(result.envs[env]).length === 0) {
        delete result.envs[env];
      }
    }

    // ส่งออกผลลัพธ์เป็น JSON
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('ข้อผิดพลาด:', err.message);
    process.exit(1);
  }
}

main();



//npm run check-config