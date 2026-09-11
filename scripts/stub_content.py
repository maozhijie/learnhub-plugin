import io
io.open('src/engine/content-subsystem.ts','w',encoding='utf8',newline='\n').write("""/**
 * Content 子系统（#152 刀 8 / ADR-0043）：内容管线、笔记 resolve/反馈区、课程工作区
 * 与题库树。
 *
 * 同域新文件：内容管线是跨域装配最重的一节（队列装配要摸通道域/题库域/学习者域），
 * 放进领主 content.ts 会让它反向依赖 audit/question-bank/graph-subsystem 等下游；
 * 本文件只被门面引用，故可自由 import，跨子系统调用经窄面回引门面。
 */
""")
