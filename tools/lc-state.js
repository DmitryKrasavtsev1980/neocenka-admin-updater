chrome.storage.local.get(null).then(r => JSON.stringify({auto: r.lightCheckAuto, id: r.lightInstanceId}))
