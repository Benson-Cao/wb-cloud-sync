' WBSync Relay 常驻启动器（登录后自动运行）
' ---------------------------------------------------------------
' 放到启动文件夹即可（Win+R → shell:startup → 把本文件拖进去）：
'   C:\Users\<你>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
'
' 为什么是 VBS 而不是计划任务：注册计划任务要管理员权限，启动文件夹不需要。
' 为什么包一层循环：node 进程崩了会被自动拉起来（10 秒后重试），不用人守着。
' 令牌不写在这里：relay 自己读 ~/.wbsync/relay-config.json（见 p1/relay/run.mjs），
' 所以这个文件可以随便复制、不需要改内容。
'
' 想停掉：任务管理器结束 wscript.exe 与 node.exe，再删掉本文件。
Set sh = CreateObject("Wscript.Shell")
Do
  sh.Run """C:\Program Files\nodejs\node.exe"" ""D:\Dw phone\wb-cloud-sync\p1\relay\run.mjs""", 0, True
  WScript.Sleep 10000
Loop
