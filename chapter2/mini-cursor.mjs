// import 'dotenv/config';
import chalk from 'chalk';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { executeCommandTool, listDirectoryTool, readFileTool, writeFileTool } from './all-tools.mjs';

const model = new ChatOpenAI({
    modelName: 'qwen-coder-turbo',
    apiKey: 'sk-64e59a2a45cd4f78ab393d04e3356af7',
    temperature: 0,
    configuration: {
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    }
});


const tools = [
    readFileTool,
    writeFileTool,
    executeCommandTool,
    listDirectoryTool,
];

// 绑定工具到模型
const modelWithTools = model.bindTools(tools);

function extractToolInputsFromText(text) {
    const blocks = [];
    const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
    for (const match of text.matchAll(fenced)) {
        const raw = match[1]?.trim();
        if (!raw) continue;
        blocks.push(raw);
    }

    const toolInputs = [];
    for (const block of blocks) {
        try {
            const parsed = JSON.parse(block);
            if (parsed && typeof parsed === 'object') toolInputs.push(parsed);
            continue;
        } catch { }

        const commandMatch = block.match(/"command"\s*:\s*"((?:\\.|[^"])*)"/);
        if (commandMatch) {
            const workingDirectoryMatch = block.match(/"workingDirectory"\s*:\s*"((?:\\.|[^"])*)"/);
            const waitForExitMatch = block.match(/"waitForExit"\s*:\s*(true|false)/);
            toolInputs.push({
                command: JSON.parse(`"${commandMatch[1]}"`),
                workingDirectory: workingDirectoryMatch ? JSON.parse(`"${workingDirectoryMatch[1]}"`) : undefined,
                waitForExit: waitForExitMatch ? waitForExitMatch[1] === 'true' : undefined,
            });
            continue;
        }

        const filePathMatch = block.match(/"filePath"\s*:\s*"((?:\\.|[^"])*)"/);
        const contentMatch = block.match(/"content"\s*:\s*"([\s\S]*?)"\s*[,}]/);
        if (filePathMatch && contentMatch) {
            toolInputs.push({
                filePath: JSON.parse(`"${filePathMatch[1]}"`),
                content: contentMatch[1],
            });
            continue;
        }

        const directoryPathMatch = block.match(/"directoryPath"\s*:\s*"((?:\\.|[^"])*)"/);
        if (directoryPathMatch) {
            toolInputs.push({
                directoryPath: JSON.parse(`"${directoryPathMatch[1]}"`),
            });
        }
    }

    return toolInputs;
}

function isDevServerCommand(command) {
    return /\b(pnpm|npm)\s+run\s+dev\b/.test(command) || /\byarn\s+dev\b/.test(command);
}

// Agent 执行函数
async function runAgentWithTools(query, maxIterations = 30) {
    const messages = [
        new SystemMessage(`你是一个项目管理助手，使用工具完成任务。

当前工作目录: ${process.cwd()}

工具：
1. read_file: 读取文件
2. write_file: 写入文件
3. execute_command: 执行命令（支持 workingDirectory 参数）
4. list_directory: 列出目录

重要规则 - execute_command：
- workingDirectory 参数会自动切换到指定目录
- 当使用 workingDirectory 时，绝对不要在 command 中使用 cd
- 错误示例: { command: "cd react-todo-app && pnpm install", workingDirectory: "react-todo-app" }
这是错误的！因为 workingDirectory 已经在 react-todo-app 目录了，再 cd react-todo-app 会找不到目录
- 正确示例: { command: "pnpm install", workingDirectory: "react-todo-app" }
这样就对了！workingDirectory 已经切换到 react-todo-app，直接执行命令即可

必须通过工具调用来完成任务的执行，不要在文本中输出任何“命令 JSON”“步骤脚本”来让用户手动复制运行。
当需要执行命令或读写文件时，直接调用工具。
工具调用完成后，最终只用简短中文总结你做了什么。`),
        new HumanMessage(query)
    ];

    for (let i = 0; i < maxIterations; i++) {
        // console.log(`⏳ 正在等待 AI 思考...`);
        console.log(chalk.bgGreen(`⏳ 正在等待 AI 思考...`));
        const response = await modelWithTools.invoke(messages);
        console.log(chalk.bgGreen(`✅ AI 回复: ${response}`));
        messages.push(response);
        // 检查是否有工具调用
        if (!response.tool_calls || response.tool_calls.length === 0) {
            const toolInputs = extractToolInputsFromText(response.content || '');
            if (toolInputs.length === 0) {
                console.log(`\n✨ AI 最终回复:\n${response.content}\n`);
                return response.content;
            }

            for (const input of toolInputs) {
                if (input && typeof input === 'object' && typeof input.command === 'string') {
                    const waitForExit = typeof input.waitForExit === 'boolean'
                        ? input.waitForExit
                        : !isDevServerCommand(input.command);
                    await executeCommandTool.invoke({
                        command: input.command,
                        workingDirectory: input.workingDirectory,
                        waitForExit,
                    });
                    continue;
                }

                if (input && typeof input === 'object' && typeof input.filePath === 'string' && typeof input.content === 'string') {
                    await writeFileTool.invoke({ filePath: input.filePath, content: input.content });
                    continue;
                }

                if (input && typeof input === 'object' && typeof input.directoryPath === 'string') {
                    await listDirectoryTool.invoke({ directoryPath: input.directoryPath });
                    continue;
                }

                if (input && typeof input === 'object' && typeof input.filePath === 'string') {
                    await readFileTool.invoke({ filePath: input.filePath });
                }
            }

            console.log(`\n✨ 已按输出中的 JSON 块执行了命令/文件操作。\n`);
            return '已执行';
        }

        // 执行工具调用
        for (const toolCall of response.tool_calls) {
            const foundTool = tools.find(t => t.name === toolCall.name);
            if (foundTool) {
                const toolResult = await foundTool.invoke(toolCall.args);
                messages.push(new ToolMessage({
                    content: toolResult,
                    tool_call_id: toolCall.id,
                }));
            }
        }
    }

    return messages[messages.length - 1].content;
}
const case1 = `创建一个功能丰富的 React TodoList 应用：

1. 创建项目：echo -e "n\nn" | pnpm create vite react-todo-app --template react-ts
2. 修改 src/App.tsx，实现完整功能的 TodoList：
 - 添加、删除、编辑、标记完成
 - 分类筛选（全部/进行中/已完成）
 - 统计信息显示
 - localStorage 数据持久化
3. 添加复杂样式：
 - 渐变背景（蓝到紫）
 - 卡片阴影、圆角
 - 悬停效果
4. 添加动画：
 - 添加/删除时的过渡动画
 - 使用 CSS transitions
5. 列出目录确认

注意：使用 pnpm，功能要完整，样式要美观，要有动画效果

之后在 react-todo-app 项目中：
1. 使用 pnpm install 安装依赖
2. 使用 pnpm run dev 启动服务器
`;

try {
    await runAgentWithTools(case1);
} catch (error) {
    console.error(`\n❌ 错误: ${error.message}\n`);
}
