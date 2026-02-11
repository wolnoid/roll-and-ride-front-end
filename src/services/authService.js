const BASE_URL = `${import.meta.env.VITE_BACK_END_SERVER_URL}/auth`;

function parseTokenPayload(token) {
  return JSON.parse(atob(token.split(".")[1])).payload;
}

async function authRequest(path, formData) {
  const res = await fetch(`${BASE_URL}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formData),
  });

  const data = await res.json();

  if (data.err) {
    throw new Error(data.err);
  }

  if (!data.token) {
    throw new Error("Invalid response from server");
  }

  localStorage.setItem("token", data.token);
  return parseTokenPayload(data.token);
}

const signUp = async (formData) => {
  try {
    return await authRequest("sign-up", formData);
  } catch (err) {
    console.log(err);
    throw new Error(err.message || String(err));
  }
};

const signIn = async (formData) => {
  try {
    return await authRequest("sign-in", formData);
  } catch (err) {
    console.log(err);
    throw new Error(err.message || String(err));
  }
};

export { signUp, signIn };
