const serverless = require("serverless-http");
const express = require("express");
const app = express();
const AWS = require("aws-sdk");
var moment = require("moment");
const mysql = require("mysql2");
require("dotenv").config();
const {
  SHOP,
  STORE_ACCESS_TOKEN,
  SES_ACCESS_KEY,
  SES_SECRET,
  SES_REGION,
  CLIENT_KEY,
  SECRET_KEY,
  SITE_URL,
  DB_ENDPOINT,
  DB_PASSWORD,
  DB_USERNAME,
  DB_PORT,
} = process.env;

const username = CLIENT_KEY;
const password = SECRET_KEY;
const auth =
  "Basic " + Buffer.from(username + ":" + password).toString("base64");
const site_url = SITE_URL;

const connection = mysql.createConnection({
  host: DB_ENDPOINT,
  user: DB_USERNAME,
  password: DB_PASSWORD,
  port: DB_PORT,
  database: "abandon_cart",
});

const sendQuery = (con, sql) => {
  con.query(sql, function (err, result) {
    if (err) throw err;
    return result;
  });
};

let emails = [];
let queryDate = moment();
queryDate = queryDate.subtract(1, "day").format("YYYY-MM-DD[T]HH:mm:ssZ");
let url =
  "https://" +
  SHOP +
  "/admin/api/2019-07/checkouts.json?updated_at_min=" +
  queryDate;

const SES_CONFIG = {
  accessKeyId: SES_ACCESS_KEY,
  secretAccessKey: SES_SECRET,
  region: SES_REGION,
};
const AWS_SES = new AWS.SES(SES_CONFIG);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getEmailConsent = async (email, checkout_unsubscribe, products) => {
  const options = {
    method: "POST",
    url: "https://consent.api.hp.com/api/v1/oauth/v1/token",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: auth,
    },
    form: {
      grant_type: "client_credentials",
      scope:
        "consent.api.hp.com/consent.create consent.api.hp.com/consent.read consent.api.hp.com/library.read",
    },
  };
  var request = require("request");
  request(options, function (error, response) {
    if (error) throw new Error(error);
    let oauth = JSON.parse(response.body);
    return CheckConsent(
      oauth.access_token,
      email,
      checkout_unsubscribe,
      products
    );
  });
};

const CheckConsent = (_access_token, email, checkout_unsubscribe, products) => {
  const options = {
    method: "POST",
    url: "https://consent.api.hp.com/api/v1/consents/.search",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + _access_token,
    },
    body: JSON.stringify({
      filter: `email eq ${email}`,
      purposeSearchType: "match",
    }),
  };
  var request = require("request");
  request(options, function (error, response) {
    if (error) throw new Error(error);
    let consentresponse = JSON.parse(response.body);
    if (consentresponse.hasOwnProperty("records")) {
      let record = consentresponse.records[0];
      let optin = record.action;
      if (optin === "opt-in") {
        const tempData = `{"email": "${email}", "checkout_unsubscribe": "${checkout_unsubscribe}", "site_url": "${site_url}"}`;
        var sql = `SELECT email FROM email WHERE email = "${email}"`;
        connection.query(sql, function (err, result) {
          if (err) throw err;
          if (result.length > 0) {
            console.log("Email already sent");
          } else {
            sendEmail("raysamtob@gmail.com", tempData);
            console.log("Email sent");
            sendQuery(
              connection,
              `INSERT INTO email (email) VALUES ( "${email}")`
            );
          }
        });
      }
    }
  });
};

let sendEmail = (recipientEmail, tempData) => {
  let params = {
    Source: "support@hpdevone.com",
    Template: "AbandonCartEmailTemplate",
    Destination: {
      ToAddresses: [recipientEmail],
    },
    TemplateData: tempData,
  };
  return AWS_SES.sendTemplatedEmail(params).promise();
};

const getCheckoutItems = async (checkouts) => {
  for (let i = 0; i < checkouts.length; i++) {
    const checkout = checkouts[i];
    const checkout_email = checkout.email;
    let checkout_url = checkout.abandoned_checkout_url;
    const products = checkout.line_items;
    if (!emails.includes(checkout_email)) {
      emails.push(checkout_email);
      const checkout_unsubscribe = checkout_url.replace(
        "recover",
        "unsubscribe"
      );
      await getEmailConsent(checkout_email, checkout_unsubscribe, products);
    }
    await wait(500);
  }
};

const getCheckouts = (url) => {
  return new Promise(function (resolve, reject) {
    var request = require("request");
    request(
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": STORE_ACCESS_TOKEN,
        },
        uri: url,
        method: "GET",
      },
      function (err, res, body) {
        if (err || res.statusCode != 200) {
          reject(err || { statusCode: res.statusCode });
        }
        resolve(res);
      }
    );
  });
};
const getAbandonCheckouts = async (url) => {
  console.log("get abandon checkouts details");
  let link = "";
  let urls = [];
  let res = await getCheckouts(url);
  let checkouts = JSON.parse(res.body).checkouts;
  await getCheckoutItems(checkouts);
  let header = res.headers;
  while (header.hasOwnProperty("link")) {
    const urlRegex = /(https?:\/\/[^ ]*)/;
    link = header.link;
    link = link.match(urlRegex)[1];
    link = link.replace(">", "");
    link = link.replace(";", "");
    url = link;
    if (!urls.includes(url)) {
      urls.push(url);
      console.log(url);
      res = await getCheckouts(url);
      checkouts = JSON.parse(res.body).checkouts;
      await getCheckoutItems(checkouts);
      header = res.headers;
    } else {
      console.log("done");
      break;
    }
  }
  return emails;
};
app.get("/", (req, res) => {
  res.send("Get abandon checkouts details");
});
app.get("/get/abandon/checkouts", async (req, res) => {
  //return all abandon cart emails from db or from shopify
  const email = await getAbandonCheckouts(url);
  res.send(JSON.stringify(email));
});
// app.listen(3000, () => console.log(`Listening on: 3000`));
module.exports.handler = serverless(app);
