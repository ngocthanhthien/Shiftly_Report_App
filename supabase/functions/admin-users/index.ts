import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Supabase Auth only signs in by email/phone. A "username" account gets a synthetic,
// never-mailed address so the person only ever sees/types their username. Must match the
// same transform the client uses in index.html's login form (both derive it from the same
// project URL).
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;
function shadowDomain(supabaseUrl: string) {
  return new URL(supabaseUrl).hostname.split(".")[0] + ".users.internal";
}
function usernameToEmail(username: string, supabaseUrl: string) {
  return username + "@" + shadowDomain(supabaseUrl);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Chỉ hỗ trợ phương thức POST" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Thiếu Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Máy chủ chưa cấu hình SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Xác thực caller từ JWT token
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user: callerAuth }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !callerAuth) {
      return new Response(
        JSON.stringify({ error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Tạo admin client với service_role key trên server
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 3. Kiểm tra caller có quyền admin trong members và không bị vô hiệu hóa
    const { data: callerMember, error: callerErr } = await adminClient
      .from("members")
      .select("user_id, display_name, role, disabled")
      .eq("user_id", callerAuth.id)
      .maybeSingle();

    if (callerErr || !callerMember || callerMember.role !== "admin" || callerMember.disabled) {
      return new Response(
        JSON.stringify({ error: "Từ chối truy cập: Yêu cầu quyền Quản trị viên (Admin)." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Đọc body và điều hướng action
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Dữ liệu JSON không hợp lệ" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action } = body;

    // ACTION: list-users
    if (action === "list-users") {
      const { data: { users: authUsers }, error: listAuthErr } = await adminClient.auth.admin.listUsers({
        perPage: 1000,
      });
      if (listAuthErr) {
        throw new Error(`Không thể lấy danh sách Auth users: ${listAuthErr.message}`);
      }

      const { data: members, error: listMemErr } = await adminClient
        .from("members")
        .select("user_id, display_name, role, disabled, username");
      if (listMemErr) {
        throw new Error(`Không thể lấy danh sách members: ${listMemErr.message}`);
      }

      const memberMap = new Map((members || []).map((m: any) => [m.user_id, m]));
      const authUserMap = new Map((authUsers || []).map((u: any) => [u.id, u]));
      const allUserIds = new Set([...memberMap.keys(), ...authUserMap.keys()]);

      const userList = [];
      for (const uid of allUserIds) {
        const authUser: any = authUserMap.get(uid);
        const member: any = memberMap.get(uid);

        const isBanned = authUser?.banned_until ? new Date(authUser.banned_until) > new Date() : false;
        const isDisabled = !!member?.disabled || isBanned;

        userList.push({
          userId: uid,
          displayName: member?.display_name || authUser?.user_metadata?.display_name || authUser?.email?.split("@")[0] || "N/A",
          // Username accounts sign in with a synthetic email the person never sees — show
          // their username instead; only a real email (Admin accounts) is shown as email.
          username: member?.username || null,
          email: member?.username ? null : (authUser?.email || "(Không có email)"),
          role: member?.role || "user",
          status: isDisabled ? "Disabled" : "Active",
          hasMemberRecord: !!member,
          createdAt: authUser?.created_at || null,
        });
      }

      // Sắp xếp: Admin lên đầu, sau đó theo họ tên A-Z
      userList.sort((a, b) => {
        if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
      });

      return new Response(JSON.stringify({ users: userList }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACTION: create-user
    if (action === "create-user") {
      const { displayName, email, username, password, role = "user" } = body;

      const trimmedName = String(displayName || "").trim();
      const trimmedUsername = String(username || "").trim().toLowerCase();
      const trimmedEmail = String(email || "").trim().toLowerCase();
      const userPassword = String(password || "");
      const selectedRole = ["admin", "supervisor"].includes(role) ? role : "user";
      // Username login (no email) for the common case; a real email stays available for
      // Admin accounts, or anyone who explicitly needs to sign in with one.
      const usingUsername = !trimmedEmail && !!trimmedUsername;

      if (!trimmedName) {
        return new Response(JSON.stringify({ error: "Họ và tên không được để trống." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let authEmail = trimmedEmail;
      if (usingUsername) {
        if (!USERNAME_RE.test(trimmedUsername)) {
          return new Response(
            JSON.stringify({ error: "Tên đăng nhập không hợp lệ: 2-32 ký tự, chữ thường/số, có thể chứa . _ -, không bắt đầu/kết thúc bằng ký tự đặc biệt." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        authEmail = usernameToEmail(trimmedUsername, supabaseUrl);
      } else {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmedEmail)) {
          return new Response(JSON.stringify({ error: "Địa chỉ email không đúng định dạng." }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      if (userPassword.length < 6) {
        return new Response(JSON.stringify({ error: "Mật khẩu phải có tối thiểu 6 ký tự." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Tạo user trong Supabase Auth
      const { data: createdAuth, error: createAuthErr } = await adminClient.auth.admin.createUser({
        email: authEmail,
        password: userPassword,
        email_confirm: true,
        user_metadata: { display_name: trimmedName },
      });

      if (createAuthErr || !createdAuth?.user) {
        const msg = createAuthErr?.message || "Không xác định";
        const friendly = /already.*registered|already.*exists/i.test(msg)
          ? (usingUsername ? "Tên đăng nhập đã được sử dụng." : "Email đã được sử dụng.")
          : `Lỗi tạo tài khoản Auth: ${msg}`;
        return new Response(JSON.stringify({ error: friendly }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const newUserId = createdAuth.user.id;

      // Cấp quyền trong members
      const { error: insertMemberErr } = await adminClient.from("members").insert({
        user_id: newUserId,
        display_name: trimmedName,
        role: selectedRole,
        disabled: false,
        username: usingUsername ? trimmedUsername : null,
      });

      // Rollback nếu chèn members thất bại để tránh tài khoản mồ côi
      if (insertMemberErr) {
        await adminClient.auth.admin.deleteUser(newUserId);
        const friendly = /duplicate|unique/i.test(insertMemberErr.message)
          ? "Tên đăng nhập đã được sử dụng."
          : `Lỗi phân quyền members: ${insertMemberErr.message}. Đã hủy tạo tài khoản Auth.`;
        return new Response(JSON.stringify({ error: friendly }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Ghi audit log
      await adminClient.from("member_audit").insert({
        actor_id: callerAuth.id,
        actor_name: callerMember.display_name,
        action: "USER_CREATED",
        detail: `Tạo người dùng ${trimmedName} (${usingUsername ? "@" + trimmedUsername : trimmedEmail}), vai trò: ${selectedRole}`,
      });

      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            userId: newUserId,
            displayName: trimmedName,
            email: usingUsername ? null : authEmail,
            username: usingUsername ? trimmedUsername : null,
            role: selectedRole,
            status: "Active",
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ACTION: change-role
    if (action === "change-role") {
      const { targetUserId, newRole } = body;

      if (!targetUserId) {
        return new Response(JSON.stringify({ error: "Thiếu targetUserId" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!["user", "admin", "supervisor"].includes(newRole)) {
        return new Response(JSON.stringify({ error: "Vai trò mới không hợp lệ (chỉ chấp nhận user, supervisor hoặc admin)." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Kiểm tra tránh Admin tự hạ quyền nếu là Admin duy nhất
      if (targetUserId === callerAuth.id && newRole !== "admin") {
        const { count, error: countErr } = await adminClient
          .from("members")
          .select("user_id", { count: "exact", head: true })
          .eq("role", "admin")
          .eq("disabled", false)
          .neq("user_id", callerAuth.id);

        if (countErr || !count || count === 0) {
          return new Response(
            JSON.stringify({ error: "Không thể hạ quyền: Bạn là Quản trị viên đang hoạt động duy nhất của hệ thống." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      const { data: targetMember } = await adminClient
        .from("members")
        .select("display_name, role")
        .eq("user_id", targetUserId)
        .maybeSingle();

      const oldRole = targetMember?.role || "user";

      const { error: updateErr } = await adminClient
        .from("members")
        .update({ role: newRole })
        .eq("user_id", targetUserId);

      if (updateErr) {
        return new Response(JSON.stringify({ error: `Lỗi cập nhật vai trò: ${updateErr.message}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Audit log
      await adminClient.from("member_audit").insert({
        actor_id: callerAuth.id,
        actor_name: callerMember.display_name,
        action: "ROLE_CHANGED",
        detail: `Đổi vai trò người dùng ${targetMember?.display_name || targetUserId} từ ${oldRole} thành ${newRole}`,
      });

      return new Response(JSON.stringify({ ok: true, role: newRole }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACTION: disable-user
    if (action === "disable-user") {
      const { targetUserId } = body;

      if (!targetUserId) {
        return new Response(JSON.stringify({ error: "Thiếu targetUserId" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (targetUserId === callerAuth.id) {
        return new Response(JSON.stringify({ error: "Không thể tự vô hiệu hóa tài khoản của chính bạn." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Khóa tài khoản trong Supabase Auth (ban 100 năm)
      const { error: banErr } = await adminClient.auth.admin.updateUserById(targetUserId, {
        ban_duration: "876600h",
      });
      if (banErr) {
        return new Response(JSON.stringify({ error: `Lỗi vô hiệu hóa trong Auth: ${banErr.message}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Cập nhật disabled = true trong members
      const { error: memberErr } = await adminClient
        .from("members")
        .update({ disabled: true })
        .eq("user_id", targetUserId);

      if (memberErr) {
        return new Response(JSON.stringify({ error: `Lỗi cập nhật bảng thành viên: ${memberErr.message}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: targetMember } = await adminClient
        .from("members")
        .select("display_name")
        .eq("user_id", targetUserId)
        .maybeSingle();

      // Audit log
      await adminClient.from("member_audit").insert({
        actor_id: callerAuth.id,
        actor_name: callerMember.display_name,
        action: "USER_DISABLED",
        detail: `Vô hiệu hóa người dùng ${targetMember?.display_name || targetUserId}`,
      });

      return new Response(JSON.stringify({ ok: true, status: "Disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACTION: enable-user
    if (action === "enable-user") {
      const { targetUserId } = body;

      if (!targetUserId) {
        return new Response(JSON.stringify({ error: "Thiếu targetUserId" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Bỏ ban trong Supabase Auth
      const { error: unbanErr } = await adminClient.auth.admin.updateUserById(targetUserId, {
        ban_duration: "none",
      });
      if (unbanErr) {
        return new Response(JSON.stringify({ error: `Lỗi kích hoạt trong Auth: ${unbanErr.message}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Cập nhật disabled = false trong members
      const { error: memberErr } = await adminClient
        .from("members")
        .update({ disabled: false })
        .eq("user_id", targetUserId);

      if (memberErr) {
        return new Response(JSON.stringify({ error: `Lỗi cập nhật bảng thành viên: ${memberErr.message}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: targetMember } = await adminClient
        .from("members")
        .select("display_name")
        .eq("user_id", targetUserId)
        .maybeSingle();

      // Audit log
      await adminClient.from("member_audit").insert({
        actor_id: callerAuth.id,
        actor_name: callerMember.display_name,
        action: "USER_ENABLED",
        detail: `Kích hoạt lại người dùng ${targetMember?.display_name || targetUserId}`,
      });

      return new Response(JSON.stringify({ ok: true, status: "Active" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Action '${action}' không được hỗ trợ.` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Đã xảy ra lỗi nội bộ trên máy chủ." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
