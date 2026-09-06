#!/usr/bin/env python3
# 生成世界导入结构测试 fixtures (5 种打包形态)
import os, zipfile

FIX = os.path.join(os.path.dirname(__file__), 'fixtures')
os.makedirs(FIX, exist_ok=True)

LEVEL_DAT = b'\x0a\x00\x00\x00fake-level-dat-for-structure-test'
DB = b'\x00' * 64  # 假 db 文件

def mini_world(root, name, with_garbage=False, extra_top=()):
    wd = os.path.join(root, name)
    os.makedirs(os.path.join(wd, 'db'), exist_ok=True)
    os.makedirs(os.path.join(wd, 'resource_packs'), exist_ok=True)
    with open(os.path.join(wd, 'level.dat'), 'wb') as f: f.write(LEVEL_DAT)
    with open(os.path.join(wd, 'level.dat_old'), 'wb') as f: f.write(LEVEL_DAT)
    with open(os.path.join(wd, 'levelname.txt'), 'w', encoding='utf-8') as f: f.write(name + '\n')
    with open(os.path.join(wd, 'db', '00001.ldb'), 'wb') as f: f.write(DB)
    with open(os.path.join(wd, 'world_icon.jpeg'), 'wb') as f: f.write(b'\xff\xd8fake')
    for t in extra_top:
        p = os.path.join(root, t)
        if t.endswith('/'):
            os.makedirs(p, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(p), exist_ok=True) if '/' in t else None
            with open(p, 'wb') as f: f.write(b'junk')
    if with_garbage:
        os.makedirs(os.path.join(root, '__MACOSX'), exist_ok=True)
        with open(os.path.join(root, '__MACOSX', '._' + name), 'wb') as f: f.write(b'g')
        with open(os.path.join(root, '.DS_Store'), 'wb') as f: f.write(b'g')

def make(name, path):
    zf = os.path.join(FIX, name)
    if os.path.exists(zf): os.remove(zf)
    with zipfile.ZipFile(zf, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, dirs, files in os.walk(path):
            for fn in files:
                fp = os.path.join(base, fn)
                arc = os.path.relpath(fp, os.path.dirname(path))
                z.write(fp, arc)
    print(f'{name}: {os.path.getsize(zf)} bytes')

# A: 单文件夹 (模拟 4VL+bsRNWCs=)
pA = os.path.join(FIX, '_wA'); os.makedirs(pA, exist_ok=True)
mini_world(pA, '极限 (2)')
make('A_single_folder.zip', os.path.join(pA, '极限 (2)'))

# B: 单文件夹 + 打包垃圾
pB = os.path.join(FIX, '_wB'); os.makedirs(pB, exist_ok=True)
mini_world(pB, '极限 (2)', with_garbage=True)
make('B_folder_with_junk.zip', os.path.join(pB, '极限 (2)'))

# C: 双层嵌套
pC = os.path.join(FIX, '_wC', '导出', '我的世界'); os.makedirs(pC, exist_ok=True)
mini_world(pC, 'WorldFolder')
make('C_deep_nested.zip', os.path.join(FIX, '_wC'))

# D: zip 根即世界内容
pD = os.path.join(FIX, '_wD'); os.makedirs(pD, exist_ok=True)
mini_world(pD, 'rootworld')
d_root = os.path.join(pD, 'rootworld')
# 直接把内容铺到 _wD 根
import shutil
for fn in os.listdir(d_root):
    shutil.move(os.path.join(d_root, fn), os.path.join(pD, fn))
os.rmdir(d_root)
make('D_root_content.zip', pD)

# E: 无效存档 (无 level.dat)
pE = os.path.join(FIX, '_wE'); os.makedirs(os.path.join(pE, 'notes'), exist_ok=True)
with open(os.path.join(pE, 'readme.txt'), 'w') as f: f.write('not a world')
make('E_no_leveldat.zip', pE)

# 清理源目录
for d in ['_wA','_wB','_wC','_wD','_wE']:
    shutil.rmtree(os.path.join(FIX, d), ignore_errors=True)
print('FIXTURES DONE')
