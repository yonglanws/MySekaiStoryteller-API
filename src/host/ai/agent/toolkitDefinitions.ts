import type { LlmToolDefinition } from '../llm'

export const STORY_AGENT_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'lookup_character',
      description:
        '一次批量查询全部出场角色的 modelId、模型路径、可用云端服装、完整重写人设（核心机制/重要记忆/语言与风格/会说与绝不会说/人际称呼）、表演气质；设 includeExpressions: true 时同步返回按情绪分组的丰富表情与多风格动作调色板。',
      parameters: {
        type: 'object',
        properties: {
          character: {
            type: 'string',
            description: '单个角色全名、简称或关键字（多角色请优先用 characters 数组）'
          },
          characters: {
            type: 'array',
            items: { type: 'string' },
            description: '推荐：一次批量查询多个出场角色（如 ["瑞希","绘名"]），节省步数'
          },
          modelId: { type: 'number', description: '可选单个角色 modelId' },
          modelIds: {
            type: 'array',
            items: { type: 'number' },
            description: '可选：一次批量查询多个 modelId'
          },
          unitHint: {
            type: 'string',
            description:
              '可选：组合提示（如 25时 / WS / VBS / MMJ / L/n），用于精准匹配虚拟歌手所在「世界」人设与服装'
          },
          contextText: {
            type: 'string',
            description:
              '可选：剧情上下文文本，用于自动匹配变体人设（如优男彰人 / 优等生真冬）与场景服装'
          },
          includeExpressions: {
            type: 'boolean',
            description:
              '推荐设为 true：同步返回每个角色按情绪分组的多样化表情（含 cry/sad 变体）与跨风格动作调色板，省去额外的 inspect_character_expressions 轮次'
          },
          moods: {
            type: 'array',
            items: { type: 'string' },
            description: '配合 includeExpressions 使用的情绪清单（留空则返回核心 7 类情绪总览）'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inspect_character_expressions',
      description:
        '按情绪/剧情台词语义查询指定角色（支持 modelIds/characters 一次查多角色、moods 一次查多情绪）的可用身体动作（motion）和带 motion3 语义注释的表情（facial）。若 lookup_character 已设 includeExpressions: true，通常无需再重复调用。',
      parameters: {
        type: 'object',
        properties: {
          modelId: { type: 'number', description: '单个角色 modelId' },
          modelIds: {
            type: 'array',
            items: { type: 'number' },
            description: '批量查询多个角色 modelId'
          },
          character: { type: 'string', description: '单个角色名或简称（未传 modelId 时使用）' },
          characters: {
            type: 'array',
            items: { type: 'string' },
            description: '批量查询多个角色名或简称'
          },
          mood: {
            type: 'string',
            description:
              '按单个情绪或动作关键词筛选，例如：伤心、苦笑、道歉、微笑、生气、点头、思考'
          },
          moods: {
            type: 'array',
            items: { type: 'string' },
            description:
              '推荐：一次批量查询多个情绪（如 ["伤心","生气","惊讶","平静","困扰"]），节省工具步数'
          },
          dialogueLine: {
            type: 'string',
            description: '可选：传入实际台词文本，自动推导戏剧气氛并优先返回最贴合该句的表情与动作'
          },
          emotion: {
            type: 'string',
            description: '可选：TTS 情绪标签（平静/开心/生气/伤心/害羞/惊讶）'
          },
          kind: {
            type: 'string',
            enum: ['all', 'motion', 'facial'],
            description: '只查动作、只查表情或全查（默认 all）'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recommend_acting_for_lines',
      description:
        '按需为指定台词匹配贴合剧情情绪的表情与动作候选。注意：常规创作无需把整场几十句台词重发一遍给此工具！直接基于 lookup_character(includeExpressions:true) 的调色板起草进 save_story_draft；仅在审校阶段对少数疑难句调用（支持 useCurrentDraft: true + onlyIssues: true 或 snippetIndices 免重发台词）。',
      parameters: {
        type: 'object',
        properties: {
          useCurrentDraft: {
            type: 'boolean',
            description:
              '直接从已保存草稿读取台词（无需重复传 lines），推荐配合 onlyIssues 或 snippetIndices 使用'
          },
          onlyIssues: {
            type: 'boolean',
            description: '配合 useCurrentDraft 使用：仅针对审校标出的问题台词返回替代建议'
          },
          snippetIndices: {
            type: 'array',
            items: { type: 'number' },
            description: '配合 useCurrentDraft 使用：仅查询指定 snippet 下标的台词'
          },
          limit: {
            type: 'number',
            description: '每句返回的候选上限（默认小批量 4、大批量 2，保持上下文紧凑）'
          },
          lines: {
            type: 'array',
            description:
              '可选：手动传入少量待查台词 [{ id?, modelId?, speaker?, content, emotion?, isListener?, isMonologue?, listenerModelId?, listenerSpeaker? }]',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                modelId: { type: 'number' },
                speaker: { type: 'string' },
                content: { type: 'string' },
                emotion: { type: 'string' },
                isListener: { type: 'boolean' },
                isMonologue: { type: 'boolean' },
                listenerModelId: {
                  type: 'number',
                  description: '可选：同台听者 modelId，提供时同步返回句首(at: 0)听者微表情建议'
                },
                listenerSpeaker: {
                  type: 'string',
                  description: '可选：同台听者角色名（未传 listenerModelId 时使用）'
                }
              },
              required: ['content']
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_assets',
      description:
        '检索目录中真实存在的背景（background）、BGM、官方音效（se）、场景粒子特效（effect）与角色换装（outfit）。支持传 kinds 数组和 queries 数组在单次调用内批量检索多类素材！',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['background', 'bgm', 'se', 'effect', 'outfit', 'all'],
            description: '单个资源类别（批量查询时优先用 kinds）'
          },
          kinds: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['background', 'bgm', 'se', 'effect', 'outfit', 'all']
            },
            description: '推荐：一次批量查询多个类别，如 ["background","bgm","se"]'
          },
          query: {
            type: 'string',
            description: '单个场景/时段/氛围/服装关键词，如 夜晚、天台、校服、钢琴、脚步'
          },
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: '推荐：一次批量传入多个关键词（如 ["连廊","悲伤","脚步"]），合并去重返回'
          },
          character: { type: 'string', description: '查询 outfit 时可指定角色名' },
          modelId: { type: 'number', description: '查询 outfit 时可指定基础 modelId' },
          limit: { type: 'number', description: '每类最多返回条数（默认 12）' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_official_corpus',
      description:
        '检索 Project SEKAI 官方剧情语料（含 2025/2026 JP+CN 活动、对白样本与重写人设记忆），支持结构化检索（mode="search"）、展开官方剧集连续上下文（mode="expand"）和浏览可用故事目录（mode="list_stories"）。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['search', 'expand', 'list_stories'],
            description:
              '操作模式：search（默认，结构化检索+章节列表）、expand（展开指定 scenarioId 上下文）、list_stories（浏览官方故事目录）'
          },
          query: { type: 'string', description: '剧情事件、角色关系或地点关键词' },
          stage: {
            type: 'string',
            enum: ['cast', 'dialogue', 'acting'],
            description: '参考阶段（默认 dialogue）'
          },
          cast: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：同台角色名数组，提升多角色共现官方剧集排序权重'
          },
          scenarioId: {
            type: 'string',
            description: 'mode="expand" 时必填：从 search/list_stories 返回的官方剧集 scenarioId'
          },
          aroundLine: {
            type: 'number',
            description: 'mode="expand" 时可选：以第几句台词为中心向前后展开'
          },
          radiusChunks: {
            type: 'number',
            description: 'mode="expand" 时可选：前后各展开几个切片（默认 2）'
          },
          unit: {
            type: 'string',
            description: 'mode="list_stories" 时可选：按组合筛选（25时 / WS / VBS / MMJ / L/n）'
          },
          recentOnly: {
            type: 'boolean',
            description: 'mode="list_stories" 时可选：仅列 2025/2026 近期新剧情'
          },
          limit: {
            type: 'number',
            description: 'mode="list_stories" 返回上限（默认 20）'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'compile_dialogue_workflow',
      description:
        '【工作流编译器】将调研好的分幕大纲与纯对白台词（lines 或 turns）交给结构化 Staging + VoiceDirection + Acting + composeStory 编译器，一键生成零布局冲突、零穿帮动作、通过全套官方舞台校验的 Live2D StoryData 并自动存入工作区草稿（无需手写 150 条原始 snippet）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '短标题' },
          event: { type: 'string', description: '本场核心小事件' },
          logline: { type: 'string', description: '一句话梗概' },
          background: { type: 'string', description: '开场背景名或云端 ID' },
          ambient: { type: 'string', enum: ['normal', 'evening', 'night'] },
          bgm: { type: 'string', description: '开场 BGM 曲名或云端 ID（可选）' },
          cast: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                modelId: { type: 'number' },
                name: { type: 'string' },
                role: { type: 'string' },
                outfit: { type: 'string' }
              }
            }
          },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                summary: { type: 'string' },
                background: { type: 'string' },
                ambient: { type: 'string', enum: ['normal', 'evening', 'night'] },
                transitionIn: { type: 'string' },
                activeCast: { type: 'array', items: { type: 'string' } },
                bgm: { type: 'string' },
                telop: { type: 'string' },
                placeInfo: { type: 'string' },
                isFlashback: { type: 'boolean' },
                isSekai: { type: 'boolean' }
              }
            }
          },
          lines: {
            type: 'array',
            description:
              '纯台词数组 [{ id?, speaker, content, emotion?, sceneId?, pauseBefore?, closeWindowAfter?, ttsCaption?, ttsSpeed?, ttsSpecialScene? }]',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                speaker: { type: 'string' },
                content: { type: 'string' },
                emotion: { type: 'string' },
                sceneId: { type: 'string' },
                pauseBefore: { type: 'number' },
                closeWindowAfter: { type: 'boolean' },
                motion: { type: 'string' },
                facial: { type: 'string' },
                ttsCaption: { type: 'string' },
                ttsSpeed: { type: 'number' },
                ttsSpecialScene: { type: 'boolean' }
              },
              required: ['speaker', 'content']
            }
          },
          turns: {
            type: 'array',
            description: '可选：按 turns 分组传入 [{ speaker, scene?, lines: [...] }]'
          },
          pairwiseAddress: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                zh: { type: 'string' },
                ja: { type: 'string' }
              }
            }
          },
          runLlmStages: {
            type: 'boolean',
            description:
              '若挂载了 llm 是否并发调用 Staging/Voice/Direction 导演（默认 true；false 时纯确定性离线编译）'
          },
          autoSaveDraft: {
            type: 'boolean',
            description: '编译后是否自动保存到工作区草稿（默认 true）'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_story_outline',
      description:
        '规划并保存本场剧本结构大纲（标题、出场角色、自然分幕、起承转合节点、意象回扣、两两称呼表），自动校验角色/背景/BGM 并提示是否过度分幕。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          logline: { type: 'string' },
          event: { type: 'string' },
          cast: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                modelId: { type: 'number' },
                name: { type: 'string' },
                role: { type: 'string' }
              }
            }
          },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                summary: { type: 'string' },
                background: { type: 'string' },
                ambient: { type: 'string', enum: ['normal', 'evening', 'night'] },
                transitionIn: { type: 'string' },
                activeCast: { type: 'array', items: { type: 'string' } },
                bgm: { type: 'string' },
                isFlashback: { type: 'boolean' },
                isSekai: { type: 'boolean' }
              }
            }
          },
          beats: { type: 'array', items: { type: 'string' } },
          turningPoint: { type: 'string' },
          openingMotif: { type: 'string' },
          closingCallback: { type: 'string' },
          pairwiseAddress: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                zh: { type: 'string' },
                ja: { type: 'string' }
              }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'validate_dialogue_draft',
      description:
        '用规则质检器检查台词草稿：检测括号动作提示泄露、AI 抒情套话、结尾说教、齐整句长、称呼偏差与文本框溢出，同时允许正常括号心里话。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          lines: {
            type: 'array',
            description: '台词数组 [{ id?, speaker, content }]',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                speaker: { type: 'string' },
                content: { type: 'string' }
              },
              required: ['speaker', 'content']
            }
          }
        },
        required: ['lines']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_story_draft',
      description:
        '保存当前完整 StoryData 草稿到 Agent 工作区，并立即返回精简质检摘要（无需重复回传长 JSON），后续可直接用 inspect_story_draft / patch_story_draft 局部精修并 finalize_story_draft 交卷。',
      parameters: {
        type: 'object',
        properties: {
          story: {
            type: 'object',
            description: '完整 StoryData 对象（含 models、images、snippets，可选 bgm）'
          },
          models: { type: 'array', items: { type: 'object' } },
          images: { type: 'array', items: { type: 'object' } },
          snippets: { type: 'array', items: { type: 'object' } },
          bgm: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inspect_story_draft',
      description:
        '分页或按问题筛选查看已保存的剧本草稿片段（按 snippet 索引返回角色、台词、表情、动作、delay 等紧凑视图），用于精准定位要修补的行。',
      parameters: {
        type: 'object',
        properties: {
          startIndex: { type: 'number', description: '起始 snippet 下标（默认 0）' },
          endIndex: {
            type: 'number',
            description: '结束 snippet 下标（不含，默认 startIndex + 25）'
          },
          type: {
            type: 'string',
            enum: ['all', 'Talk', 'LayoutAppear', 'LayoutClear', 'Motion', 'Move', 'transitions'],
            description: '筛选片段类型'
          },
          onlyIssues: {
            type: 'boolean',
            description: '仅列出存在表演/官方规范问题的片段（默认 false）'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'patch_story_draft',
      description:
        '对已保存的草稿执行局部外科修补（改某句台词、切换某个 Talk/Appear/Motion 的 facial 或 motion、增删片段），无需重写整份大 JSON！',
      parameters: {
        type: 'object',
        properties: {
          models: {
            type: 'array',
            items: { type: 'object' },
            description: '可选：整体替换 models'
          },
          images: {
            type: 'array',
            items: { type: 'object' },
            description: '可选：整体替换 images'
          },
          operations: {
            type: 'array',
            description: '局部修改操作列表（按顺序应用）',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: [
                    'replace',
                    'update_talk',
                    'update_acting',
                    'upsert_listener_action',
                    'insert_before',
                    'insert_after',
                    'delete'
                  ]
                },
                index: { type: 'number', description: '目标 snippet 下标' },
                snippet: { type: 'object', description: 'replace 时的新 snippet 对象' },
                snippets: {
                  type: 'array',
                  items: { type: 'object' },
                  description: 'insert_before / insert_after 时要插入的 snippet 数组'
                },
                content: { type: 'string' },
                emotion: { type: 'string' },
                ttsCaption: {
                  type: 'string',
                  description: '可选：IrodoriTTS 逐句日语声演/韵律描述（不含年龄/性别/声线词）'
                },
                ttsSpeed: {
                  type: 'number',
                  description: '可选：IrodoriTTS 语速微调（常规 0.92~1.08，高潮 0.85~1.18）'
                },
                ttsSpecialScene: {
                  type: 'boolean',
                  description: '可选：极端哭喊/崩溃/耳语高潮句设为 true（整场 <= 15%）'
                },
                delay: { type: 'number' },
                closeWindowOnFinish: { type: 'boolean' },
                motion: {
                  type: 'string',
                  description: '说话者或片段主体的 motion（设为空串可清除）'
                },
                facial: { type: 'string', description: '说话者或片段主体的 facial' },
                listenerAction: {
                  type: 'object',
                  description:
                    '为 Talk 片段新增/更新听者反应（默认 at: 0 纯表情，不与说话者身体动作冲突；如需听者身体动作请插独立 Motion 片段）',
                  properties: {
                    modelId: { type: 'number', description: '听者 modelId' },
                    at: { type: 'number', description: '触发时刻（默认 0，纯表情无需错峰）' },
                    facial: { type: 'string', description: '听者微表情（推荐仅传 facial）' },
                    motion: {
                      type: 'string',
                      description:
                        '可选：仅当说话者本句无身体动作时生效；否则自动保留纯表情以避免双人动作碰撞'
                    },
                    remove: { type: 'boolean', description: '为 true 时移除该听者的动作' }
                  },
                  required: ['modelId']
                },
                actions: {
                  type: 'array',
                  items: { type: 'object' },
                  description: '直接替换 Talk/Motion 的 actions 数组'
                }
              },
              required: ['op', 'index']
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'critique_story_draft',
      description:
        '对剧本草稿运行全维度逐句导演审校：检查剧情与表情/动作语义冲突、重复呆板表情、0动作角色、双人同瞬动作碰撞、括号动作泄露、官方节奏规范与对白质感，并给出逐句推荐替代项！',
      parameters: {
        type: 'object',
        properties: {
          story: {
            type: 'object',
            description: '可选：待检查 StoryData（省略时直接检查已保存的草稿）'
          },
          useCurrentDraft: { type: 'boolean' },
          maxDiagnostics: { type: 'number', description: '最多返回诊断条数（默认 15）' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'validate_story_draft',
      description:
        '运行完整 Schema 校验 + 官方舞台规范检查（入场冲突、双人同瞬动作、动作切换分布、括号动作泄露、背景与资源合法性），支持直接校验已保存草稿。',
      parameters: {
        type: 'object',
        properties: {
          story: {
            type: 'object',
            description: '完整 StoryData JSON 对象（省略时校验已保存的草稿）'
          },
          useCurrentDraft: { type: 'boolean' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'submit_director_review',
      description:
        '对已保存剧本执行真正的【5 维导演终审】，审视：戏剧弧光与收尾、情绪连贯与人物口吻、BGM/PlaySe 音效设计、舞台节奏（Wait/独立 Motion 静默拍/Move/单双人切镜/淡入淡出）与表情动作自然度；可同步提交 operations 一次性完成所有外科修补，并设 finalizeIfReady: true 一步定稿！',
      parameters: {
        type: 'object',
        properties: {
          dramaticArc: {
            type: 'string',
            description: '评估开场抓手、中段情绪转折、句长节奏（是否有短促反应与潜台词）与结尾余韵'
          },
          emotionalContinuityAndVoice: {
            type: 'string',
            description:
              '评估角色口吻真实度、情绪过渡自然度（严禁在哭泣/悲伤/紧绷段穿插「平静」标签，避免哭戏 TTS 笑场）与关键句 ttsCaption/ttsSpecialScene 声演设计'
          },
          audioAndSeDesign: {
            type: 'string',
            description: '评估开场与切停 BGM（如高潮静音留白）及 PlaySe 物理/情绪音效是否到位'
          },
          stageRhythm: {
            type: 'string',
            description:
              '评估单人 Center 特写与双人 Left/Right 原地淡入淡出切镜（isMoved:false，严禁 Move 滑动）、Wait/独立 Motion 静默拍（每 40 句约 16~22 处）、SideFade/Flashback/AmbientColor 与克制的镜头/震动使用'
          },
          actingNaturalness: {
            type: 'string',
            description:
              '评估表情/动作多样性与自然度（避免 4 动作死循环，也避免机械每句乱动；情绪延续自然保持姿态或微调表情）'
          },
          concreteFixes: {
            type: 'array',
            items: { type: 'string' },
            description: '本轮审校发现并准备修补的具体清单（若无须修改可为空数组）'
          },
          operations: {
            type: 'array',
            description:
              '可选：与 patch_story_draft 完全相同格式的局部修补操作列表，将在审校同时落地',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: [
                    'replace',
                    'update_talk',
                    'update_acting',
                    'upsert_listener_action',
                    'insert_before',
                    'insert_after',
                    'delete'
                  ]
                },
                index: { type: 'number' },
                snippet: { type: 'object' },
                snippets: { type: 'array', items: { type: 'object' } },
                content: { type: 'string' },
                emotion: { type: 'string' },
                ttsCaption: {
                  type: 'string',
                  description: '可选：IrodoriTTS 逐句日语声演/韵律描述（不含年龄/性别/声线词）'
                },
                ttsSpeed: {
                  type: 'number',
                  description: '可选：IrodoriTTS 语速微调（常规 0.92~1.08，高潮 0.85~1.18）'
                },
                ttsSpecialScene: {
                  type: 'boolean',
                  description: '可选：极端哭喊/崩溃/耳语高潮句设为 true（整场 <= 15%）'
                },
                delay: { type: 'number' },
                closeWindowOnFinish: { type: 'boolean' },
                motion: { type: 'string' },
                facial: { type: 'string' },
                listenerAction: { type: 'object' },
                actions: { type: 'array', items: { type: 'object' } }
              },
              required: ['op', 'index']
            }
          },
          finalizeIfReady: {
            type: 'boolean',
            description:
              '若修补后全部校验通过则直接定稿提交（推荐 true，省去额外一轮 finalize_story_draft）'
          }
        },
        required: [
          'dramaticArc',
          'emotionalContinuityAndVoice',
          'audioAndSeDesign',
          'stageRhythm',
          'actingNaturalness'
        ]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finalize_story_draft',
      description:
        '确认已保存并通过导演终审的草稿无误后直接定稿提交，无需再次输出长 JSON（长篇草稿 >=8 句须先经过 submit_director_review）。',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '可选：定稿说明' }
        }
      }
    }
  }
]
