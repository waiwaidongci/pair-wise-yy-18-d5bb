module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '已封箱', '巡演中', '待复核', '可演出', '已闭环'],
      required: ['showName', 'venue', 'play'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-2',
      status: '可演出',
      data: {
        role: '孙悟空',
        play: '火焰山',
        paintStatus: '彩绘完好',
        mechanism: '火眼金睛机关正常',
        accessories: ['紫金冠'],
        boxNo: '木箱甲-01',
        currentUsable: true
      },
      note: '巡演主力偶头'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-3',
      status: '可演出',
      data: {
        role: '铁扇公主',
        play: '火焰山',
        paintStatus: '彩绘完好',
        mechanism: '水袖机关正常',
        accessories: ['凤冠'],
        boxNo: '木箱甲-02',
        currentUsable: true
      },
      note: '巡演主力偶头'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-2',
      status: '在库',
      data: {
        name: '紫金冠',
        role: '孙悟空',
        play: '火焰山',
        boxNo: '配件箱-01'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-3',
      status: '在库',
      data: {
        name: '凤冠',
        role: '铁扇公主',
        play: '火焰山',
        boxNo: '配件箱-01'
      }
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes/pack 创建装箱单并封箱前核对偶头、配件与箱号',
    'POST /api/tourBoxes/:id/seal 补封签（未结束装箱单内封签号唯一，并发沿用首次结果）',
    'POST /api/tourBoxes/:id/arrive 到场解封登记，不符只转待复核',
    'POST /api/tourBoxes/:id/correct 更正箱号/清单/封签，原解封与演出资格失效留档'
  ]
};
