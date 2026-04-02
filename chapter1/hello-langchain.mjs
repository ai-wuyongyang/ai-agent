import { ChatOpenAI } from '@langchain/openai';
const model = new ChatOpenAI({
    modelName:'qwen-coder-turbo',
    apiKey:'sk-64e59a2a45cd4f78ab393d04e3356af7',
    configuration:{
        baseURL:'https://dashscope.aliyuncs.com/compatible-mode/v1',
    }
   });
   const res = await model.invoke('介绍一下你自己');
   console.log(res.content);

