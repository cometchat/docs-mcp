// The page a user opens to approve one high-risk change (see approval.ts).
// It shows exactly what will happen, every argument (secrets masked), and a
// warning that text inside their app can try to trick an AI tool. Only the
// browser that connected the AI tool can approve; there's deliberately no
// "sign in here to approve" fallback, because the AI tool could drive that.
import { APPROVE_PATH, scriptJson, type ApprovalService } from "./approval.js";
import { esc, page } from "./oauth.js";

export function approvalPage(approvals: ApprovalService, r: unknown): { nonce: string; body: string } {
  const req = approvals.openRequest(r);
  if (!req) {
    return page(
      "Approval link expired",
      `<h1>This approval link has expired</h1><p>Approval links last 15 minutes. Ask your AI tool to try the change again, and it will give you a new link.</p>`,
    );
  }
  const rows = req.x.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  const body = `<h1>Approve a change to your CometChat account</h1>
<p>Your AI tool wants to make this change. It only happens if you approve it here.</p>
<div class="client"><div class="avatar" aria-hidden="true">!</div><div><strong>${esc(req.tt)}</strong><span>${esc(req.s)}</span></div></div>
<div class="label">Exact details</div>
<table>${rows}</table>
<div class="warn" role="note"><strong>Only approve a change you asked for</strong>Messages, names and other text in your app can contain instructions meant to trick an AI tool. If you didn't ask for this, close this page.</div>
<button class="btn" id="approve" type="button">Approve</button>
<div id="result" hidden><div class="label">Your approval code</div><div class="code" id="code"></div><p>Give this code to your AI tool. It works once, for this exact change, for up to 10 minutes.</p></div>
<div id="status" role="status" aria-live="polite"><span class="spin" aria-hidden="true"></span><span id="status-text"></span></div>`;
  const script = `<script>
(function(){var r=${scriptJson(r)},btn=document.getElementById("approve"),box=document.getElementById("status"),t=document.getElementById("status-text");
function show(msg,kind){t.textContent=msg;box.className="show"+(kind?" "+kind:"")}
btn.addEventListener("click",function(){btn.disabled=true;show("Approving…");
fetch(${scriptJson(APPROVE_PATH)},{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"content-type":"application/json","x-cometchat-approve":"1"},body:JSON.stringify({r:r})}).then(function(x){return x.json()}).then(function(res){
if(res.status==="approved"){btn.hidden=true;document.getElementById("code").textContent=res.code;document.getElementById("result").hidden=false;show("Approved.","ok");return}
btn.hidden=true;
if(res.status==="sign_in_required"){show(res.reason==="different_account"
?"This browser is connected as a different CometChat account than the one your AI tool uses. Open this link in the browser where you connected your AI tool."
:"Open this link in the browser where you connected your AI tool to CometChat. If that isn't possible, reconnect CometChat in your AI tool (it opens a sign-in page in this browser), then ask it to try the change again.","err");return}
if(res.status==="expired"){show("This approval link has expired. Ask your AI tool to try again.","err");return}
btn.hidden=false;btn.disabled=false;show(res.message||"Something went wrong. Try again.","err")}).catch(function(){btn.disabled=false;show("Couldn't reach CometChat. Try again.","err")})});
})();
</script>`;
  return page("Approve a change", body, script);
}
