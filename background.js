chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  console.log("Background got message:", message);

  
  if (message.type === "FIND_OR_CREATE_PRODUCT") {
    fetch("http://localhost:3000/products/find-or-create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message.payload)
    })
      .then(res => res.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message.type === "TRACK_EVENT") {
    fetch("http://localhost:3000/event", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message.payload)
    })
      .then(res => res.text())
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: error.message }));

    return true;
  }
if (message.type === "CREATE_STOCK_ALERT") {
  console.log("Creating stock alert for:", message.payload.product_id);

  fetch("http://localhost:3000/stock-alerts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      user_id: "11111111-1111-1111-1111-111111111111",
      product_id: message.payload.product_id
    })
  })
    .then(async (res) => {
      const data = await res.json();
      console.log("Create stock alert response:", res.status, data);
      sendResponse({ ok: res.ok, data });
    })
    .catch(error => {
      console.error("Create stock alert failed:", error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
}
  
});

/*async function checkNotifications() {
  const userId = '11111111-1111-1111-1111-111111111111';

  try {
    const res = await fetch(`http://localhost:3000/stock-alerts/${userId}/available`);
    const data = await res.json();
    console.log('Stock notifications data:', data);
    for (const item of data) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'your product is back!',
        message: `${item.brand} - ${item.product_name}`
      });
      await fetch('http://localhost:3000/stock-alerts/mark-notified', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    alert_id: item.alert_id
  })
});
    }
  } catch (err) {
    console.error('Notification check failed:', err);
  }
}
setInterval(checkNotifications, 60 * 1000);

checkNotifications();*/