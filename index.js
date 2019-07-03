const Twitter = require('twitter');
const Telegraf = require('telegraf');
const { OAuth } = require('oauth');
const Koa = require('koa');

const config = require('./config.json');

const bot = new Telegraf(config.telegramBotToken);
const oa = new OAuth(
    'https://twitter.com/oauth/request_token',
    'https://twitter.com/oauth/access_token',
    config.twitterConsumerKey,
    config.twitterConsumerSecret,
    '1.0A',
    'http://34.80.161.163/',
    'HMAC-SHA1'
);
const srv = new Koa();
const session = {};    // key    to session
const sessionMap = {}; // chatId to session
const msgOptions = {
    parse_mode: 'HTML',
    disable_web_page_preview: true
};

process.on('uncaughtException', console.error);
process.on('unhandledRejection', (e) => { throw e });

bot.start((ctx) => {
    oa.getOAuthRequestToken((error, key, secret) => {
        if (error) {
            console.log(error);
            ctx.reply('Error fetching OAuth Token.');
        } else {
            let chatId = ctx.message.chat.id;
            sessionMap[chatId] = session[key] = { secret, chat: chatId };
            ctx.reply(`<a href="https://api.twitter.com/oauth/authenticate?oauth_token=${ key }">Sign in with Twitter</a>`, msgOptions);
        }
    });
});

srv.use(async (ctx, next) => {
    let { oauth_token: key, oauth_verifier: code } = ctx.query;
    if (!key || !code) ctx.throw(400);

    await new Promise((resolve) => {
        oa.getOAuthAccessToken(key, session[key].secret, code, (error, token, secret) => {
            if (error) {
                console.log(error);
                ctx.body = 'Error fetching OAuth Token.';
            } else {
                session[key].token = token;
                session[key].secret = secret;
                session[key].client = new Twitter({
                    consumer_key: config.twitterConsumerKey,
                    consumer_secret: config.twitterConsumerSecret,
                    access_token_key: token,
                    access_token_secret: secret
                })
                session[key].lastId = null;
                session[key].task = setInterval(update.bind(null, key), 60000);
                update(key);

                ctx.redirect('https://t.me/rikumi_bot');
                resolve();
            }
        })
    })
});

function update(key) {
    with (session[key]) {
        const options = {};
        if (!lastId) {
            options.count = 10;
        } else {
            options.since_id = lastId;
        }
        client.get('statuses/home_timeline', options, async (error, tweets) => {
            if (error) {
                console.log(error);
                // bot.telegram.sendMessage(session[key].chat, 'Error fetching tweets.');
            } else {
                tweets = tweets.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
                for (let tweet of tweets) {
                    await sendTweet(session[key].chat, tweet);
                    lastId = tweet.id_str;
                }
            }
        })
    }
}

async function sendTweet(chatId, tweet) {
    let { mediaType, mediaUrls, text } = buildTweet(tweet);

    switch (mediaType) {
        case 'photo':
            if (mediaUrls.length > 1) {
                let [pic] = await bot.telegram.sendMediaGroup(chatId, mediaUrls.map(url => ({ type: 'photo', media: url })));
                await bot.telegram.sendMessage(chatId, text, { reply_to_message_id: pic.message_id, ...msgOptions });
            } else {
                await bot.telegram.sendPhoto(chatId, mediaUrls[0], { caption: text, ...msgOptions });
            }
            break;
        case 'video':
            await bot.telegram.sendVideo(chatId, mediaUrls[0], { caption: text, ...msgOptions });
            break;
        case 'animated_gif':
            await bot.telegram.sendAnimation(chatId, mediaUrls[0], { caption: text, ...msgOptions });
            break;
        default:
            await bot.telegram.sendMessage(chatId, text, { ...msgOptions });
    }
}

function buildTweet(tweet) {
    let { user, text, entities, extended_entities = {} } = tweet;
    let { hashtags, user_mentions: mentions, urls } = entities;
    let { media = [] } = extended_entities;
    let mediaType = media[0] && media[0].type;

    entities = [
        ...hashtags.map(k => Object.assign(k, { entityType: 'hashtag' })),
        ...mentions.map(k => Object.assign(k, { entityType: 'mention' })),
        ...media.map(k => Object.assign(k, { entityType: 'media' })),
        ...urls.map(k => Object.assign(k, { entityType: 'url' }))
    ].sort((a, b) => b.indices[0] - a.indices[0]);

    let processedUpTo = Math.min();
    let mediaUrls = [];
    for (let entity of entities) {
        let { entityType, indices: [from, to] } = entity;
        let replaceText = '';

        switch (entityType) {
            case 'mention':
                let { name, screen_name } = entity;
                replaceText = `<a href="https://twitter.com/${ screen_name }">@${ name }</a> `;
                break;
            case 'hashtag':
                let { text } = entity;
                replaceText = `<a href="https://twitter.com/hashtag/${ text }">#${ text }</a> `;
                break;
            case 'url':
                let { expanded_url, display_url } = entity;
                replaceText = `<a href="${ expanded_url }">${ display_url }</a> `;
                break;
            case 'media':
                let { media_url_https: url } = entity;
                replaceText = '';
                mediaUrls.push(url);
                break;
        }

        if (processedUpTo >= to) {
            text = text.substring(0, from) + replaceText + text.substring(to);
            processedUpTo = from;
        }
    }

    text = text.replace(/^(<a [^>]*>@[^<]*<\/a>\s*)+/, '').trim();

    if (mediaType && /<\/a>\s*:$/.test(text)) {
        text += ` [${ /\w+$/.exec(mediaType)[0] }]`;
    }

    return {
        mediaType,
        mediaUrls,
        text: `<a href="https://twitter.com/${ tweet.user.screen_name }/status/${ tweet.id_str }">${ tweet.in_reply_to_status_id_str ? '💬' : '🔗' }</a> | ` +
              `<a href="https://twitter.com/${ tweet.user.screen_name }">${ user.name }</a>: ${ text }`
    }
}

bot.launch();
srv.listen(80);