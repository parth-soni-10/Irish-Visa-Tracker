export async function onRequest(context) {
  return new Response(JSON.stringify({ 
    message: "Functions working!", 
    path: new URL(context.request.url).pathname 
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}